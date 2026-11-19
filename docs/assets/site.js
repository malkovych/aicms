(function () {
  var lang = document.documentElement.lang === "uk" ? "uk" : "en";
  var T = {
    en: {
      requires: "requires ", gives: "provides ",
      added: ": added",
      autoAdded: function (p, m, r) { return "+ " + p + ": added automatically because " + m + " requires " + r; },
      off: ": removed",
      alsoOff: function (m, r) { return "− " + m + ": also removed because it requires " + r; },
      hint: "Try Reviews: it requires commerce, and commerce requires payments.",
      nav: ["Content", "Media", "Inbox", "Agents", "Modules"],
      navMod: { forms: "Forms", commerce: "Shop", reviews: "Reviews" },
      shipping: "DHL", payments: { label: "Stripe" }
    },
    uk: {
      requires: "потребує ", gives: "дає ",
      added: ": додано",
      autoAdded: function (p, m, r) { return "+ " + p + ": додано автоматично, бо " + m + " потребує " + r; },
      off: ": вимкнено",
      alsoOff: function (m, r) { return "− " + m + ": теж вимкнено, бо потребує " + r; },
      hint: "Спробуй Reviews: він потребує commerce, а commerce потребує payments.",
      nav: ["Контент", "Медіа", "Вхідні", "Агенти", "Модулі"],
      navMod: { forms: "Форми", commerce: "Магазин", reviews: "Відгуки" },
      shipping: "Нова пошта", payments: { label: "LiqPay" }
    }
  }[lang];

  /* ---------- hero tabs ---------- */
  var tablist = document.getElementById("demoTabs");
  if (tablist) {
    var tabs = [].slice.call(tablist.querySelectorAll('[role="tab"]'));
    var select = function (t) {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute("aria-selected", on ? "true" : "false");
        x.tabIndex = on ? 0 : -1;
        document.getElementById(x.getAttribute("aria-controls")).hidden = !on;
      });
    };
    tabs.forEach(function (t) { t.addEventListener("click", function () { select(t); }); });
    tablist.addEventListener("keydown", function (e) {
      var i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      var j = null;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      if (j !== null) { e.preventDefault(); tabs[j].focus(); select(tabs[j]); }
    });
  }

  /* ---------- lego modules ---------- */
  var wrap = document.getElementById("legoBricks");
  if (!wrap) return;
  var BASE_TOOLS = ["cms_describe", "cms_search", "cms_submit", "cms_changes", "post_list", "post_get", "post_draft", "post_delete"];
  var MODS = {
    seo: { label: "SEO", provides: "seo", tools: ["seo_audit", "seo_report"] },
    i18n: { label: "i18n", provides: "i18n", tools: ["i18n_translate", "i18n_missing"] },
    media: { label: "Media", provides: "media", tools: ["media_upload", "media_list", "media_update"] },
    search: { label: "Search", provides: "search", tools: ["search_reindex"] },
    forms: { label: "Forms", provides: "forms", tools: ["form_submissions", "form_export"], nav: "forms" },
    commerce: { label: "Commerce", provides: "commerce", requires: ["payments"], tools: ["product_draft", "order_list", "order_status"], nav: "commerce" },
    payments: { label: T.payments.label, provides: "payments", tools: ["payments_status", "payments_refund"] },
    shipping: { label: T.shipping, provides: "shipping", requires: ["commerce"], tools: ["shipping_quote", "shipping_create_label"] },
    reviews: { label: "Reviews", provides: "reviews", requires: ["commerce"], tools: ["review_list", "reviews_moderate"], nav: "reviews" }
  };
  var ORDER = Object.keys(MODS);
  var PROVIDER = { payments: "payments", commerce: "commerce" };
  var active = { seo: true, media: true };
  var countEl = document.getElementById("toolCount");
  var listEl = document.getElementById("toolList");
  var navEl = document.getElementById("navList");
  var logEl = document.getElementById("legoLog");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  ORDER.forEach(function (id) {
    var m = MODS[id];
    var b = document.createElement("button");
    b.type = "button"; b.className = "lbrick"; b.id = "mod-" + id;
    b.innerHTML = '<span class="lb-name"></span><span class="lb-meta"></span>';
    b.querySelector(".lb-name").textContent = m.label;
    b.querySelector(".lb-meta").textContent = m.requires ? T.requires + m.requires.join(", ") : T.gives + m.provides;
    b.addEventListener("click", function () { toggle(id); });
    wrap.appendChild(b);
  });

  function provided() {
    var s = {};
    ORDER.forEach(function (id) { if (active[id]) s[MODS[id].provides] = true; });
    return s;
  }
  function add(id, msgs, auto) {
    active[id] = true;
    if (!auto) msgs.push("+ " + MODS[id].label + T.added);
    (MODS[id].requires || []).forEach(function (r) {
      if (!provided()[r]) {
        var pid = PROVIDER[r];
        msgs.push(T.autoAdded(MODS[pid].label, MODS[id].label, r));
        add(pid, msgs, true);
      }
    });
  }
  function toggle(id) {
    var msgs = [];
    if (active[id]) {
      delete active[id];
      msgs.push("− " + MODS[id].label + T.off);
      var changed = true;
      while (changed) {
        changed = false;
        var p = provided();
        ORDER.forEach(function (a) {
          if (!active[a]) return;
          var miss = (MODS[a].requires || []).filter(function (x) { return !p[x]; })[0];
          if (miss) { delete active[a]; msgs.push(T.alsoOff(MODS[a].label, miss)); changed = true; }
        });
      }
    } else add(id, msgs, false);
    render(msgs.join("\n"));
  }
  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function render(msg) {
    ORDER.forEach(function (id) {
      document.getElementById("mod-" + id).setAttribute("aria-pressed", active[id] ? "true" : "false");
    });
    var modTools = [];
    ORDER.forEach(function (id) { if (active[id]) modTools = modTools.concat(MODS[id].tools); });
    var n = BASE_TOOLS.length + modTools.length;
    if (String(n) !== countEl.textContent) {
      countEl.textContent = n;
      if (!reduce) { countEl.classList.remove("bump"); void countEl.offsetWidth; countEl.classList.add("bump"); }
    }
    listEl.innerHTML =
      BASE_TOOLS.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") +
      modTools.map(function (t) { return '<li class="m">' + esc(t) + "</li>"; }).join("");
    var nav = ["<span>" + T.nav[0] + "</span>", "<span>" + T.nav[1] + "</span>"];
    ORDER.forEach(function (id) {
      if (active[id] && MODS[id].nav) nav.push('<span class="m">' + esc(T.navMod[MODS[id].nav]) + "</span>");
    });
    nav.push("<span>" + T.nav[2] + "</span>", "<span>" + T.nav[3] + "</span>", "<span>" + T.nav[4] + "</span>");
    navEl.innerHTML = nav.join("");
    logEl.style.whiteSpace = "pre-line";
    logEl.textContent = msg || T.hint;
  }
  render("");
})();
