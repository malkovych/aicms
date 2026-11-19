import { createHmac, timingSafeEqual } from "node:crypto";
import { AicmsError } from "../kernel/errors.ts";
import { defineModule, type ModuleContext } from "../kernel/modules.ts";
import type { PaymentsService, PaymentUpdated } from "./commerce.ts";

export interface ManualPaymentsOptions {
  /** Shown to the customer after checkout: bank details, cash on delivery, pickup… */
  instructions?: string;
}

/** Payments handled outside AICMS (bank transfer, cash on delivery). A person marks orders paid. */
export function manualPayments(opts: ManualPaymentsOptions = {}) {
  const service: PaymentsService & { name: string } = {
    name: "manual",
    instructions: opts.instructions ?? "We'll contact you about payment.",
    createPayment: async ({ order }) => ({ ref: `manual-${order}`, status: "pending" }),
  };
  return defineModule({
    name: "manual-payments",
    description: "Payments outside AICMS: bank transfer, cash on delivery. Orders wait until a person marks them paid.",
    provides: ["payments"],
    services: { payments: service },
  });
}

export interface StripeOptions {
  /** sk_live_… or sk_test_… (e.g. process.env.STRIPE_SECRET_KEY). */
  secretKey?: string;
  /** whsec_… from the webhook endpoint pointing at /payments/stripe/webhook. */
  webhookSecret?: string;
  /** For tests: a fetch that talks to a fake Stripe. */
  fetch?: typeof fetch;
  apiBase?: string;
}

/** Verify a Stripe-Signature header: t=<unix>,v1=<hex hmac of "t.payload">, within `toleranceSec`. */
export function verifyStripeSignature(payload: string, header: string, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest();
  return header
    .split(",")
    .filter((kv) => kv.startsWith("v1="))
    .some((kv) => {
      const got = Buffer.from(kv.slice(3), "hex");
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}

/** Stripe Checkout: a hosted payment page per order, confirmed by a signed webhook. */
export function stripe(opts: StripeOptions = {}) {
  const api = (opts.apiBase ?? "https://api.stripe.com").replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const key = () => {
    if (!opts.secretKey) throw new AicmsError("invalid", "Stripe needs a secret key: stripe({ secretKey: process.env.STRIPE_SECRET_KEY })");
    return opts.secretKey;
  };

  async function call(path: string, form: Record<string, string>, idempotencyKey?: string) {
    const res = await doFetch(`${api}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key()}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: new URLSearchParams(form).toString(),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new AicmsError("invalid", `Stripe: ${body?.error?.message ?? `HTTP ${res.status}`}`);
    return body;
  }

  const service: PaymentsService & { name: string } = {
    name: "stripe",
    async createPayment({ order, amount, currency, description, customerEmail, successUrl, cancelUrl }) {
      if (!successUrl || !cancelUrl) throw new AicmsError("invalid", "Stripe Checkout needs successUrl and cancelUrl (commerce options or the checkout request)");
      const s = await call(
        "/v1/checkout/sessions",
        {
          mode: "payment",
          "line_items[0][quantity]": "1",
          "line_items[0][price_data][currency]": currency.toLowerCase(),
          "line_items[0][price_data][unit_amount]": String(amount),
          "line_items[0][price_data][product_data][name]": `Order ${order}`,
          "line_items[0][price_data][product_data][description]": description.slice(0, 300) || `Order ${order}`,
          success_url: successUrl,
          cancel_url: cancelUrl,
          client_reference_id: order,
          "metadata[order]": order,
          ...(customerEmail ? { customer_email: customerEmail } : {}),
        },
        `aicms-order-${order}`,
      );
      return { ref: s.id, url: s.url, status: s.payment_status === "paid" ? "paid" : "pending" };
    },
    async refund({ ref }) {
      const r = await call("/v1/refunds", { payment_intent: ref }, `aicms-refund-${ref}`);
      return { status: r.status === "succeeded" ? "refunded" : "pending" };
    },
  };

  return defineModule({
    name: "stripe",
    description: "Stripe Checkout: hosted payment pages, confirmed by signed webhooks; refunds.",
    provides: ["payments"],
    services: { payments: service },
    routes: {
      "POST /payments/stripe/webhook": async ({ request, ctx }) => {
        if (!opts.webhookSecret) return Response.json({ error: { code: "invalid", message: "stripe({ webhookSecret }) is not set" } }, { status: 500 });
        const payload = await request.text();
        if (!verifyStripeSignature(payload, request.headers.get("stripe-signature") ?? "", opts.webhookSecret)) {
          return Response.json({ error: { code: "unauthorized", message: "Bad Stripe signature" } }, { status: 400 });
        }
        const event = JSON.parse(payload) as { type: string; data: { object: Record<string, any> } };
        const o = event.data?.object ?? {};
        const report = (u: Omit<PaymentUpdated, "provider">) => (ctx as ModuleContext).emit("payment.updated", { provider: "stripe", ...u });
        if (event.type === "checkout.session.completed" && o.payment_status === "paid") await report({ ref: o.id, status: "paid", intent: o.payment_intent });
        else if (event.type === "checkout.session.async_payment_succeeded") await report({ ref: o.id, status: "paid", intent: o.payment_intent });
        else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") await report({ ref: o.id, status: "failed" });
        else if (event.type === "charge.refunded" && o.payment_intent) await report({ ref: o.payment_intent, status: "refunded" });
        return Response.json({ received: true });
      },
    },
  });
}
