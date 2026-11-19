import { randomBytes } from "node:crypto";
import { z } from "zod";
import { action } from "../kernel/action.ts";
import { AicmsError } from "../kernel/errors.ts";
import { defineModule, type ModuleContext } from "../kernel/modules.ts";
import { field } from "../schema/fields.ts";
import { defineModel } from "../schema/model.ts";

/** The "payments" capability: what a payment provider module offers commerce. */
export interface PaymentsService {
  /** Start paying for an order; `url` is where to send the customer, if the provider has a page. */
  createPayment(input: {
    order: string;
    amount: number;
    currency: string;
    description: string;
    customerEmail?: string;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<{ ref: string; url?: string; status: "pending" | "paid" }>;
  /** Refund a paid order fully. */
  refund?(input: { ref: string; amount: number; currency: string }): Promise<{ status: "refunded" | "pending" }>;
  /** Shown to customers when there is no payment page (bank details, cash on delivery…). */
  instructions?: string;
}

/** Providers report payment changes with this event; commerce listens. */
export interface PaymentUpdated {
  provider: string;
  ref: string;
  status: "paid" | "failed" | "refunded";
  intent?: string;
}

export interface CommerceOptions {
  /** ISO 4217 currency for all prices, e.g. "EUR". Default "USD". */
  currency?: string;
  /** Where customers land after paying, unless checkout passes its own. */
  successUrl?: string;
  cancelUrl?: string;
}

type OrderStatus = "pending" | "paid" | "fulfilled" | "cancelled" | "refunded";
const MOVES: Record<OrderStatus, OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["fulfilled", "refunded"],
  fulfilled: ["refunded"],
  cancelled: [],
  refunded: [],
};

export const product = defineModel({
  name: "product",
  label: "Products",
  fields: {
    title: field.text({ required: true, max: 140 }),
    slug: field.slug({ from: "title" }),
    sku: field.text({ unique: true, indexed: true, max: 64, description: "Stock keeping unit" }),
    price: field.number({ required: true, integer: true, min: 0, description: "In minor units: cents, kopiyky" }),
    image: field.media(),
    description: field.blocks(["heading", "paragraph", "image", "list", "quote"]),
    stock: field.number({ integer: true, min: 0, description: "Leave empty for unlimited" }),
    active: field.boolean({ indexed: true, description: "Shown and sold" }),
  },
  agent: { guide: "Describe what the product is and who it is for. Never invent prices or stock.", can: ["create", "update"] },
});

export const order = defineModel({
  name: "order",
  label: "Orders",
  fields: {
    number: field.text({ required: true, unique: true, indexed: true }),
    status: field.enum(["pending", "paid", "fulfilled", "cancelled", "refunded"], { required: true, indexed: true }),
    items: field.json({ required: true, description: "[{ product, title, quantity, unitPrice }]" }),
    total: field.number({ required: true, integer: true, min: 0 }),
    currency: field.text({ required: true }),
    customer: field.object({ name: field.text(), email: field.text({ indexed: true }) }),
    payment: field.json({ description: "{ provider, ref, url, intent }" }),
    history: field.json({ description: "[{ at, by, status, note }]" }),
    note: field.text({ multiline: true }),
  },
  // Orders are written by the commerce module, never drafted by agents.
  agent: { can: [] },
});

const CheckoutBody = z.strictObject({
  items: z.array(z.strictObject({ product: z.string().min(1), quantity: z.number().int().min(1).max(100) })).min(1).max(50),
  customer: z.strictObject({ name: z.string().max(200).optional(), email: z.string().email().max(200) }),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (code: string, message: string, status: number) => json({ error: { code, message } }, status);

/** Products, orders and checkout. Needs a payments provider: manualPayments() or stripe(). */
export function commerce(opts: CommerceOptions = {}) {
  const currency = (opts.currency ?? "USD").toUpperCase();

  async function findProduct(ctx: ModuleContext, ref: string) {
    return (await ctx.get("product", ref)) ?? (await ctx.find("product", "sku", ref)) ?? (await ctx.find("product", "slug", ref));
  }

  async function nextNumber(ctx: ModuleContext) {
    const n = ((await ctx.kv.get<number>("seq")) ?? 1000) + 1;
    await ctx.kv.set("seq", n);
    return String(n);
  }

  async function orderBy(ctx: ModuleContext, number: string) {
    const o = await ctx.find("order", "number", number);
    if (!o) throw new AicmsError("not_found", `No order ${number}`);
    return o as Record<string, any> & { id: string };
  }

  /** Change an order's status as the module, recording who asked and why. */
  async function setStatus(ctx: ModuleContext, o: Record<string, any> & { id: string }, status: OrderStatus, by: string, note?: string, extra: Record<string, unknown> = {}) {
    if (o.status === status) return o;
    if (!MOVES[o.status as OrderStatus]?.includes(status)) throw new AicmsError("invalid", `Order ${o.number} can't go from ${o.status} to ${status}`);
    const sys = ctx.asSystem();
    const history = [...((o.history as unknown[]) ?? []), { at: new Date().toISOString(), by, status, ...(note ? { note } : {}) }];
    await sys.draft("order", { id: o.id, status, history, ...extra });
    // Paid orders take their items out of stock.
    if (status === "paid") {
      for (const it of (o.items as { product: string; quantity: number }[]) ?? []) {
        const p = await sys.get("product", it.product);
        if (p && typeof p.stock === "number") await sys.draft("product", { id: p.id, stock: Math.max(0, p.stock - it.quantity) });
      }
    }
    const r = await sys.submit(`Order ${o.number}: ${status}`);
    if (r.status !== "merged") throw new AicmsError("conflict", `Order ${o.number} couldn't be updated: ${JSON.stringify((r as { issues?: unknown }).issues ?? r)}`);
    return { ...o, status, history, ...extra };
  }

  const payments = (ctx: ModuleContext) => {
    const p = ctx.service<PaymentsService>("payments");
    if (!p) throw new AicmsError("invalid", "No payments provider is installed (add manualPayments() or stripe())");
    return p;
  };

  return defineModule({
    name: "commerce",
    description: "Products, orders and checkout with server-side prices. Needs a payments provider.",
    provides: ["commerce"],
    requires: ["payments"],
    models: [product, order],
    routes: {
      // Public checkout: prices come from the products, never from the request.
      "POST /commerce/checkout": async ({ request, ctx }) => {
        let body: z.infer<typeof CheckoutBody>;
        try {
          body = CheckoutBody.parse(await request.json());
        } catch (e) {
          return fail("invalid", e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "Expected JSON", 422);
        }
        const sys = ctx.asSystem();
        const lines: { product: string; title: string; quantity: number; unitPrice: number }[] = [];
        for (const it of body.items) {
          const p = await findProduct(sys, it.product);
          if (!p || p.active === false) return fail("not_found", `No product ${it.product} for sale`, 404);
          if (typeof p.stock === "number" && p.stock < it.quantity) return fail("conflict", `Only ${p.stock} of ${p.title} left`, 409);
          lines.push({ product: p.id, title: String(p.title), quantity: it.quantity, unitPrice: Number(p.price) });
        }
        const total = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
        const number = await nextNumber(sys);
        const key = randomBytes(12).toString("base64url");
        const at = new Date().toISOString();
        await sys.draft("order", { number, status: "pending", items: lines, total, currency, customer: body.customer, history: [{ at, by: "customer", status: "pending" }] });
        await sys.submit(`Order ${number}`);
        await sys.kv.set(`key:${number}`, key);
        let payment: Awaited<ReturnType<PaymentsService["createPayment"]>>;
        try {
          payment = await payments(sys).createPayment({
            order: number,
            amount: total,
            currency,
            description: lines.map((l) => `${l.quantity} × ${l.title}`).join(", ").slice(0, 300),
            customerEmail: body.customer.email,
            successUrl: body.successUrl ?? opts.successUrl,
            cancelUrl: body.cancelUrl ?? opts.cancelUrl,
          });
        } catch (e) {
          const o = await orderBy(sys, number);
          await setStatus(sys, o, "cancelled", "commerce", `Payment couldn't start: ${e instanceof Error ? e.message : e}`);
          return fail("payment", "The payment couldn't be started; nothing was charged", 502);
        }
        await sys.kv.set(`pay:${payment.ref}`, number);
        const provider = sys.service<{ name?: string }>("payments")?.name ?? "payments";
        let current = await orderBy(sys, number);
        await sys.draft("order", { id: current.id, payment: { provider, ref: payment.ref, ...(payment.url ? { url: payment.url } : {}) } });
        await sys.submit(`Order ${number}: payment started`);
        current = await orderBy(sys, number);
        if (payment.status === "paid") current = await setStatus(sys, current, "paid", provider);
        const instructions = !payment.url ? payments(sys).instructions : undefined;
        return json({ order: number, key, status: current.status, total, currency, items: lines, ...(payment.url ? { paymentUrl: payment.url } : {}), ...(instructions ? { instructions } : {}) }, 201);
      },
      // Order status for the customer: the key from checkout proves it's theirs.
      "GET /commerce/orders/:number": async ({ params, url, ctx }) => {
        const sys = ctx.asSystem();
        const key = await sys.kv.get<string>(`key:${params.number}`);
        if (!key || url.searchParams.get("key") !== key) return fail("not_found", "No such order", 404);
        const o = await orderBy(sys, params.number);
        return json({ order: o.number, status: o.status, total: o.total, currency: o.currency, items: o.items });
      },
    },
    on: {
      "payment.updated": async ({ payload, ctx }) => {
        const p = payload as PaymentUpdated;
        const number = await ctx.kv.get<string>(`pay:${p.ref}`);
        if (!number) return;
        const o = await orderBy(ctx, number);
        const extra = p.intent ? { payment: { ...(o.payment as object), intent: p.intent } } : {};
        if (p.intent) await ctx.kv.set(`pay:${p.intent}`, number);
        if (p.status === "paid" && o.status === "pending") await setStatus(ctx, o, "paid", p.provider, undefined, extra);
        else if (p.status === "failed" && o.status === "pending") await setStatus(ctx, o, "cancelled", p.provider, "Payment failed or expired");
        else if (p.status === "refunded" && (o.status === "paid" || o.status === "fulfilled")) await setStatus(ctx, o, "refunded", p.provider);
      },
    },
    actions: {
      orders: action({
        description: "Orders, newest first. Filter by status (pending, paid, fulfilled, cancelled, refunded).",
        scope: "commerce:orders",
        readOnly: true,
        input: z.strictObject({ status: z.enum(["pending", "paid", "fulfilled", "cancelled", "refunded"]).optional(), limit: z.number().int().min(1).max(100).optional() }),
        async run({ input, ctx }) {
          const r = await ctx.asSystem().list("order", { ...(input.status ? { where: { status: input.status } } : {}), limit: input.limit ?? 30 });
          return { total: r.total, orders: r.items.map((o: any) => ({ number: o.number, status: o.status, total: o.total, currency: o.currency, items: (o.items ?? []).length, customer: o.customer?.email, updatedAt: o.updatedAt })) };
        },
      }),
      order: action({
        description: "One order with its items, payment and history.",
        scope: "commerce:orders",
        readOnly: true,
        input: z.strictObject({ number: z.string().min(1) }),
        run: async ({ input, ctx }) => orderBy(ctx.asSystem(), input.number),
      }),
      set_status: action({
        description: "Move an order on: pending → paid (manual payments) or cancelled; paid → fulfilled or refunded (refunds go through the payment provider).",
        scope: "commerce:manage",
        input: z.strictObject({ number: z.string().min(1), status: z.enum(["paid", "fulfilled", "cancelled", "refunded"]), note: z.string().max(500).optional() }),
        async run({ input, ctx }) {
          const sys = ctx.asSystem();
          const o = await orderBy(sys, input.number);
          let note = input.note;
          if (input.status === "refunded") {
            const p = payments(sys);
            const ref = (o.payment as { intent?: string; ref?: string })?.intent ?? (o.payment as { ref?: string })?.ref;
            // Providers that can refund do it now; otherwise the money went back outside AICMS and this records it.
            if (p.refund && ref) await p.refund({ ref, amount: Number(o.total), currency: String(o.currency) });
            else note = note ?? "Refunded outside AICMS";
          }
          const updated = await setStatus(sys, o, input.status, ctx.actor.id, note);
          return { order: updated.number, status: updated.status, history: updated.history };
        },
      }),
      stats: action({
        description: "Sales overview: paid revenue, orders by status and best-selling products.",
        scope: "commerce:orders",
        readOnly: true,
        input: z.strictObject({}),
        async run({ ctx }) {
          const sys = ctx.asSystem();
          const byStatus: Record<string, number> = {};
          const sold = new Map<string, { title: string; quantity: number; revenue: number }>();
          let revenue = 0;
          for (let offset = 0; ; offset += 200) {
            const page = await sys.list("order", { limit: 200, offset });
            for (const o of page.items as any[]) {
              byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
              if (o.status === "paid" || o.status === "fulfilled") {
                revenue += Number(o.total);
                for (const it of o.items ?? []) {
                  const s = sold.get(it.product) ?? { title: it.title, quantity: 0, revenue: 0 };
                  s.quantity += it.quantity;
                  s.revenue += it.quantity * it.unitPrice;
                  sold.set(it.product, s);
                }
              }
            }
            if (offset + 200 >= page.total) break;
          }
          return { currency, revenue, byStatus, bestSellers: [...sold.entries()].sort((a, b) => b[1].quantity - a[1].quantity).slice(0, 10).map(([id, s]) => ({ product: id, ...s })) };
        },
      }),
    },
  });
}
