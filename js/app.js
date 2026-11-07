(function () {
  const STORAGE_KEY = "invoice-app-v1";
  const $ = (sel) => document.querySelector(sel);

  const state = {
    profile: null,
    clients: [],
    invoices: [],
    draft: null,
    historyFilter: "all",
    historyQuery: "",
  };
  let persistTimer = 0;
  let memoryOnly = false;
  let toastTimer = 0;

  function uid() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") {
      try { return c.randomUUID(); } catch (_) { /* file:// では使えないことがある */ }
    }
    if (c && typeof c.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function todayISO() {
    const d = new Date();
    return toISODate(d);
  }

  function toISODate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function monthEnd(iso, addMonths) {
    const parts = String(iso || todayISO()).split("-").map(Number);
    return toISODate(new Date(parts[0], parts[1] + addMonths, 0));
  }

  function addDays(iso, days) {
    const parts = String(iso || todayISO()).split("-").map(Number);
    return toISODate(new Date(parts[0], parts[1] - 1, parts[2] + days));
  }

  function formatDateJP(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
    const [y, m, d] = iso.split("-");
    return y + "年" + Number(m) + "月" + Number(d) + "日";
  }

  function formatZip(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 7) return digits.slice(0, 3) + "-" + digits.slice(3);
    return String(value || "").trim();
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"]/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
    }[ch]));
  }

  function escBr(value) {
    return esc(value).replace(/\n/g, "<br>");
  }

  function defaultProfile() {
    return {
      name: "",
      zip: "",
      address: "",
      tel: "",
      email: "",
      invoiceRegNumber: "",
      bankName: "",
      bankBranch: "",
      accountType: "普通",
      accountNumber: "",
      accountHolder: "",
      taxRounding: "floor",
      sealImage: "",
    };
  }

  function defaultClient() {
    return { name: "", honorific: "御中", person: "", zip: "", address: "", email: "" };
  }

  function blankItem() {
    return {
      id: uid(),
      description: "",
      qty: 1,
      unit: "式",
      unitPrice: "",
      taxRate: "10",
      withhold: true,
    };
  }

  function defaultDraft() {
    const issueDate = todayISO();
    return {
      id: null,
      number: "",
      issueDate,
      dueDate: monthEnd(issueDate, 1),
      subject: "",
      period: "",
      client: defaultClient(),
      items: [blankItem()],
      withholding: false,
      withholdingRate: 10.21,
      feePayer: "client",
      notes: "",
      status: "unpaid",
      useSnapshot: false,
      profileSnapshot: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  function healItem(item) {
    const source = item || {};
    let taxRate = "10";
    if (source.taxRate === "8" || source.taxRate === 8) taxRate = "8";
    if (source.taxRate === "0" || source.taxRate === 0) taxRate = "0";
    return {
      id: source.id || uid(),
      description: source.description || "",
      qty: source.qty ?? 1,
      unit: source.unit || "式",
      unitPrice: source.unitPrice ?? "",
      taxRate,
      withhold: source.withhold !== false,
    };
  }

  function healClient(client) {
    return {
      id: (client && client.id) || uid(),
      name: (client && client.name) || "",
      honorific: (client && client.honorific) || "御中",
      person: (client && client.person) || "",
      zip: (client && client.zip) || "",
      address: (client && client.address) || "",
      email: (client && client.email) || "",
    };
  }

  function healDraft(draft) {
    const d = draft || {};
    const items = Array.isArray(d.items) && d.items.length ? d.items.map(healItem) : [blankItem()];
    return {
      id: d.id || null,
      number: d.number || "",
      issueDate: d.issueDate || todayISO(),
      dueDate: d.dueDate || "",
      subject: d.subject || "",
      period: d.period || "",
      client: { ...defaultClient(), ...(d.client || {}) },
      items,
      withholding: !!d.withholding,
      withholdingRate: d.withholdingRate ?? 10.21,
      feePayer: d.feePayer || "client",
      notes: d.notes || "",
      status: d.status === "paid" ? "paid" : "unpaid",
      useSnapshot: !!(d.useSnapshot && d.profileSnapshot),
      profileSnapshot: d.profileSnapshot ? { ...defaultProfile(), ...d.profileSnapshot } : null,
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null,
    };
  }

  function isFilledItem(item) {
    return !!String(item.description || "").trim() || !!InvoiceCalc.parseNum(item.unitPrice);
  }

  function ensureBlankRow(draft) {
    if (!draft.items.some((item) => !isFilledItem(item))) draft.items.push(blankItem());
  }

  function nextNumber(issueDate) {
    const parts = String(issueDate || todayISO()).split("-");
    const prefix = parts[0] + parts[1] + "-";
    let max = 0;
    for (const inv of state.invoices) {
      if (!inv.number || !String(inv.number).startsWith(prefix)) continue;
      const n = parseInt(String(inv.number).slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return prefix + String(max + 1).padStart(3, "0");
  }

  function activeProfile() {
    if (state.draft.useSnapshot && state.draft.profileSnapshot) return state.draft.profileSnapshot;
    return state.profile;
  }

  function profileFor(inv) {
    if (inv.useSnapshot && inv.profileSnapshot) return inv.profileSnapshot;
    return state.profile;
  }

  function stableProfile(profile) {
    const p = profile || {};
    return JSON.stringify({
      name: p.name || "",
      zip: p.zip || "",
      address: p.address || "",
      tel: p.tel || "",
      email: p.email || "",
      invoiceRegNumber: p.invoiceRegNumber || "",
      bankName: p.bankName || "",
      bankBranch: p.bankBranch || "",
      accountType: p.accountType || "",
      accountNumber: p.accountNumber || "",
      accountHolder: p.accountHolder || "",
      taxRounding: p.taxRounding || "floor",
      sealImage: p.sealImage || "",
    });
  }

  function signature(draft) {
    return JSON.stringify({
      number: draft.number || "",
      issueDate: draft.issueDate || "",
      dueDate: draft.dueDate || "",
      subject: draft.subject || "",
      period: draft.period || "",
      client: {
        name: draft.client?.name || "",
        honorific: draft.client?.honorific || "",
        person: draft.client?.person || "",
        zip: draft.client?.zip || "",
        address: draft.client?.address || "",
        email: draft.client?.email || "",
      },
      items: (draft.items || []).filter(isFilledItem).map((item) => ({
        description: item.description || "",
        qty: String(item.qty ?? ""),
        unit: item.unit || "",
        unitPrice: String(item.unitPrice ?? ""),
        taxRate: String(item.taxRate ?? "10"),
        withhold: item.withhold !== false,
      })),
      withholding: !!draft.withholding,
      withholdingRate: String(draft.withholdingRate ?? ""),
      feePayer: draft.feePayer || "none",
      notes: draft.notes || "",
      snap: draft.useSnapshot ? stableProfile(draft.profileSnapshot) : "",
    });
  }

  function hasUserContent(draft) {
    return !!(
      String(draft.client?.name || "").trim() ||
      String(draft.subject || "").trim() ||
      String(draft.notes || "").trim() ||
      (draft.items || []).some(isFilledItem)
    );
  }

  function isDirty() {
    if (!state.draft.id) return hasUserContent(state.draft);
    const saved = state.invoices.find((inv) => inv.id === state.draft.id);
    if (!saved) return true;
    return signature(state.draft) !== signature(saved);
  }

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function persist() {
    clearTimeout(persistTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        profile: state.profile,
        clients: state.clients,
        invoices: state.invoices,
        draft: state.draft,
      }));
    } catch (_) {
      if (!memoryOnly) {
        memoryOnly = true;
        toast("ブラウザに保存できません。右上の書き出しで控えてください。");
      }
    }
  }

  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 150);
  }

  function load() {
    state.profile = defaultProfile();
    state.clients = [];
    state.invoices = [];
    state.draft = defaultDraft();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.profile) state.profile = { ...defaultProfile(), ...data.profile };
        state.clients = Array.isArray(data.clients) ? data.clients.map(healClient) : [];
        state.invoices = Array.isArray(data.invoices) ? data.invoices.map(healDraft) : [];
        if (data.draft) state.draft = healDraft(data.draft);
      }
    } catch (err) {
      console.warn(err);
    }
    ensureBlankRow(state.draft);
    if (!state.draft.number) state.draft.number = nextNumber(state.draft.issueDate);
  }

  function switchView(view) {
    for (const name of ["edit", "history", "settings"]) {
      $("#view-" + name).hidden = name !== view;
      document.querySelector('[data-view="' + name + '"]').classList.toggle("active", name === view);
    }
    if (view === "history") renderHistory();
    if (view === "settings") {
      fillProfile();
      renderClientAdmin();
      updateRegWarning();
      fillSealPreview();
    }
    if (view === "edit") renderPreview();
  }

  function fillProfile() {
    const p = state.profile;
    $("#p-name").value = p.name || "";
    $("#p-zip").value = p.zip || "";
    $("#p-address").value = p.address || "";
    $("#p-tel").value = p.tel || "";
    $("#p-email").value = p.email || "";
    $("#p-reg").value = p.invoiceRegNumber || "";
    $("#p-rounding").value = p.taxRounding || "floor";
    $("#p-bank").value = p.bankName || "";
    $("#p-branch").value = p.bankBranch || "";
    $("#p-account-type").value = p.accountType || "普通";
    $("#p-account-number").value = p.accountNumber || "";
    $("#p-account-holder").value = p.accountHolder || "";
  }

  function readProfileFromForm() {
    state.profile = {
      ...state.profile,
      name: $("#p-name").value,
      zip: $("#p-zip").value,
      address: $("#p-address").value,
      tel: $("#p-tel").value,
      email: $("#p-email").value,
      invoiceRegNumber: $("#p-reg").value,
      taxRounding: $("#p-rounding").value || "floor",
      bankName: $("#p-bank").value,
      bankBranch: $("#p-branch").value,
      accountType: $("#p-account-type").value,
      accountNumber: $("#p-account-number").value,
      accountHolder: $("#p-account-holder").value,
    };
  }

  function fillSealPreview() {
    const wrap = $("#seal-preview-wrap");
    const img = $("#seal-preview");
    if (state.profile.sealImage && String(state.profile.sealImage).startsWith("data:image/")) {
      img.src = state.profile.sealImage;
      wrap.hidden = false;
    } else {
      img.removeAttribute("src");
      wrap.hidden = true;
    }
    $("#btn-seal-clear").hidden = wrap.hidden;
  }

  function updateRegWarning() {
    const value = state.profile.invoiceRegNumber.trim();
    $("#reg-warning").hidden = value === "" || /^T\d{13}$/.test(value);
  }

  function fillForm() {
    const d = state.draft;
    $("#f-number").value = d.number || "";
    $("#f-issue").value = d.issueDate || "";
    $("#f-due").value = d.dueDate || "";
    $("#f-subject").value = d.subject || "";
    $("#f-period").value = d.period || "";
    $("#f-client-name").value = d.client.name || "";
    $("#f-honorific").value = d.client.honorific || "御中";
    $("#f-person").value = d.client.person || "";
    $("#f-client-zip").value = d.client.zip || "";
    $("#f-client-address").value = d.client.address || "";
    $("#f-client-email").value = d.client.email || "";
    $("#f-withholding").checked = !!d.withholding;
    $("#f-withholding-rate").value = d.withholdingRate ?? 10.21;
    $("#f-fee").value = d.feePayer || "client";
    $("#f-notes").value = d.notes || "";
    $("#f-status").value = d.status === "paid" ? "paid" : "unpaid";
    syncWithholdingUI();
    refreshClientSelect();
  }

  function readSimpleFields() {
    const previousStatus = state.draft.status;
    state.draft.number = $("#f-number").value;
    state.draft.issueDate = $("#f-issue").value;
    state.draft.dueDate = $("#f-due").value;
    state.draft.subject = $("#f-subject").value;
    state.draft.period = $("#f-period").value;
    state.draft.client.name = $("#f-client-name").value;
    state.draft.client.honorific = $("#f-honorific").value;
    state.draft.client.person = $("#f-person").value;
    state.draft.client.zip = $("#f-client-zip").value;
    state.draft.client.address = $("#f-client-address").value;
    state.draft.client.email = $("#f-client-email").value;
    state.draft.withholding = $("#f-withholding").checked;
    state.draft.withholdingRate = $("#f-withholding-rate").value;
    state.draft.feePayer = $("#f-fee").value;
    state.draft.notes = $("#f-notes").value;
    state.draft.status = $("#f-status").value === "paid" ? "paid" : "unpaid";
    if (previousStatus !== state.draft.status && state.draft.id) {
      const saved = state.invoices.find((inv) => inv.id === state.draft.id);
      if (saved) saved.status = state.draft.status;
      renderHistory();
    }
  }

  function syncWithholdingUI() {
    $("#withhold-rate-wrap").hidden = !$("#f-withholding").checked;
  }

  function refreshClientSelect() {
    const select = $("#client-pick");
    const name = state.draft.client.name.trim();
    const match = state.clients.find((client) => client.name === name);
    select.innerHTML = '<option value="">選んで反映</option>' + state.clients.map((client) => (
      '<option value="' + esc(client.id) + '">' + esc(client.name) + "</option>"
    )).join("");
    select.value = match ? match.id : "";
  }

  function readLine(row) {
    const item = state.draft.items.find((entry) => entry.id === row.dataset.id);
    if (!item) return;
    item.description = row.querySelector(".line-desc").value;
    item.qty = row.querySelector(".line-qty").value;
    item.unit = row.querySelector(".line-unit").value;
    item.unitPrice = row.querySelector(".line-price").value;
    item.taxRate = row.querySelector(".line-tax").value;
    const box = row.querySelector(".line-withhold");
    if (box) item.withhold = box.checked;
    const amount = Math.round(InvoiceCalc.parseNum(item.qty) * InvoiceCalc.parseNum(item.unitPrice));
    row.querySelector(".line-amount").textContent = InvoiceCalc.formatYen(amount);
  }

  function renderLines() {
    const draft = state.draft;
    $("#lines").innerHTML = draft.items.map((item) => {
      const amount = Math.round(InvoiceCalc.parseNum(item.qty) * InvoiceCalc.parseNum(item.unitPrice));
      const withhold = draft.withholding
        ? '<label class="check mini-check"><input type="checkbox" class="line-withhold"' + (item.withhold !== false ? " checked" : "") + ">源泉対象</label>"
        : "";
      return (
        '<div class="line" data-id="' + esc(item.id) + '">' +
          '<div class="line-top"><input class="line-desc" type="text" placeholder="品目・内容" value="' + esc(item.description) + '">' +
          '<button type="button" class="icon-btn danger" data-act="del">削除</button></div>' +
          '<div class="line-grid">' +
            '<label class="mini">数量<input class="line-qty" type="text" inputmode="decimal" value="' + esc(item.qty) + '"></label>' +
            '<label class="mini">単位<input class="line-unit" type="text" value="' + esc(item.unit) + '"></label>' +
            '<label class="mini">単価<input class="line-price" type="text" inputmode="decimal" placeholder="0" value="' + esc(item.unitPrice) + '"></label>' +
            '<label class="mini">税率<select class="line-tax">' +
              '<option value="10"' + (item.taxRate === "10" ? " selected" : "") + ">10%</option>" +
              '<option value="8"' + (item.taxRate === "8" ? " selected" : "") + ">軽減8%</option>" +
              '<option value="0"' + (item.taxRate === "0" ? " selected" : "") + ">非課税</option>" +
            "</select></label>" +
          "</div>" +
          '<div class="line-foot"><span class="line-amount">' + esc(InvoiceCalc.formatYen(amount)) + "</span><span>" +
            withhold +
            '<button type="button" class="icon-btn" data-act="up" aria-label="この行を上へ">↑</button>' +
            '<button type="button" class="icon-btn" data-act="down" aria-label="この行を下へ">↓</button>' +
          "</span></div>" +
        "</div>"
      );
    }).join("");
  }

  function addLine() {
    const item = blankItem();
    state.draft.items.push(item);
    renderLines();
    const input = document.querySelector('.line[data-id="' + CSS.escape(item.id) + '"] .line-desc');
    if (input) input.focus();
  }

  function summaryRows(result, draft) {
    const rows = [];
    const active = [10, 8, 0].filter((rate) => result.byRate[rate] !== 0);
    if (active.length === 0 || (active.length === 1 && active[0] === 10)) {
      rows.push({ label: "小計", value: result.byRate[10] + result.byRate[8] + result.byRate[0] });
      if (active.length === 0 || active[0] === 10) rows.push({ label: "消費税（10%）", value: result.tax[10] });
      rows.push({ label: "合計", value: result.total, emph: !draft.withholding });
    } else {
      if (result.byRate[10]) {
        rows.push({ label: "10%対象（税抜）", value: result.byRate[10] });
        rows.push({ label: "消費税（10%）", value: result.tax[10] });
      }
      if (result.byRate[8]) {
        rows.push({ label: "軽減8%対象（税抜）", value: result.byRate[8] });
        rows.push({ label: "消費税（軽減8%）", value: result.tax[8] });
      }
      if (result.byRate[0]) rows.push({ label: "非課税", value: result.byRate[0] });
      rows.push({ label: "合計", value: result.total, emph: !draft.withholding });
    }
    if (draft.withholding) {
      rows.push({ label: "源泉徴収税額", value: -result.withholding });
      rows.push({ label: "差引ご請求額", value: result.amountDue, emph: true });
    }
    return rows;
  }

  function rowsHTML(rows) {
    return rows.map((row) => (
      '<div class="' + (row.emph ? "emph" : "") + '"><span>' + esc(row.label) + '</span><span class="num">' + esc(InvoiceCalc.formatAccount(row.value)) + "</span></div>"
    )).join("");
  }

  function feeText(draft) {
    if (draft.feePayer === "self") return "振込手数料は当方にて負担いたします。";
    if (draft.feePayer === "none") return "";
    return "振込手数料はお客様にてご負担ください。";
  }

  function hasBank(profile) {
    return [profile.bankName, profile.bankBranch, profile.accountNumber, profile.accountHolder].some((value) => String(value || "").trim());
  }

  function renderPreview() {
    const draft = state.draft;
    const profile = activeProfile();
    const result = InvoiceCalc.calculate(draft, profile);
    const rows = summaryRows(result, draft);
    $("#totals").innerHTML = rowsHTML(rows);
    $("#sticky-label").textContent = draft.withholding ? "差引ご請求額" : "ご請求額";
    $("#sticky-total").textContent = InvoiceCalc.formatAmountDue(result.amountDue);
    const titleBits = ["請求書", draft.number, draft.client.name].map((part) => String(part || "").replace(/[\\/:*?"<>|]/g, "").trim()).filter(Boolean);
    document.title = titleBits.join("_") || "請求書";

    const clientName = draft.client.name.trim();
    const honor = draft.client.honorific || "御中";
    const address = [];
    if (draft.client.zip.trim()) address.push("〒" + draft.client.zip.trim());
    if (draft.client.address.trim()) address.push(draft.client.address.trim());
    const period = draft.period.trim() || formatDateJP(draft.issueDate);
    const seal = String(profile.sealImage || "").startsWith("data:image/") ? profile.sealImage : "";
    const issuerAddress = [];
    if (profile.zip.trim()) issuerAddress.push("〒" + profile.zip.trim());
    if (profile.address.trim()) issuerAddress.push(profile.address.trim());

    const bankLines = [];
    const bankTitle = [profile.bankName, profile.bankBranch].map((part) => part.trim()).filter(Boolean).join("　");
    if (bankTitle) bankLines.push(bankTitle);
    const account = [profile.accountType, profile.accountNumber].map((part) => String(part || "").trim()).filter(Boolean).join("　");
    if (account) bankLines.push(account);
    if (profile.accountHolder.trim()) bankLines.push(profile.accountHolder.trim());
    const bankReady = hasBank(profile);
    const fee = bankReady ? feeText(draft) : "";
    const showBank = bankReady;
    const showDue = !!draft.dueDate;

    const notes = [];
    if (result.byRate[8]) notes.push("※は軽減税率（8%）の対象です。");
    if (draft.withholding && result.withholding) notes.push("源泉徴収税額は、対象行の税抜金額の合計に税率を乗じ、1円未満を切り捨てています。");

    const itemRows = result.items.length
      ? result.items.map((item) => (
        "<tr><td class=\"desc\">" + escBr(item.description || "（無題）") + "</td>" +
        '<td class="num">' + esc(String(item.qty)) + "</td>" +
        "<td>" + esc(item.unit || "") + "</td>" +
        '<td class="num">' + esc(InvoiceCalc.formatComma(item.unitPrice)) + "</td>" +
        "<td>" + (item.taxRate === 8 ? "8%※" : item.taxRate === 0 ? "非課税" : "10%") + "</td>" +
        '<td class="num">' + esc(InvoiceCalc.formatComma(item.amount)) + "</td></tr>"
      )).join("")
      : '<tr><td class="desc screen-hint" colspan="6">明細がありません</td></tr>';

    const pay = (showBank || showDue) ? (
      '<div class="pay">' +
        (showBank ? '<section class="box bank">' + (hasBank(profile) ? "<h2>お振込先</h2><p>" + escBr(bankLines.join("\n")) + "</p>" : "") + (fee ? '<p class="fee">' + esc(fee) + "</p>" : "") + "</section>" : "") +
        (showDue ? '<section class="box due"><h2>お支払期限</h2><p class="due-date num">' + esc(formatDateJP(draft.dueDate)) + "</p></section>" : "") +
      "</div>"
    ) : "";

    $("#sheet-mount").innerHTML =
      '<article class="sheet" id="sheet">' +
        "<h1><span>請</span><span>求</span><span>書</span></h1>" +
        '<div class="title-rule"></div>' +
        '<div class="parties"><section class="billto">' +
          (clientName
            ? '<p class="billto-name">' + esc(clientName) + " " + esc(honor) + "</p>"
            : '<p class="billto-name screen-hint">請求先未入力</p>') +
          (address.length ? "<p>" + escBr(address.join("\n")) + "</p>" : "") +
          (draft.client.person.trim() ? "<p>ご担当：" + esc(draft.client.person.trim()) + " 様</p>" : "") +
        "</section><section class=\"issuer\">" +
          '<p class="meta-line"><span>請求書番号</span><span class="num">' + esc(draft.number || "—") + "</span></p>" +
          '<p class="meta-line"><span>発行日</span><span>' + esc(formatDateJP(draft.issueDate) || "—") + "</span></p>" +
          '<p class="meta-line"><span>取引日</span><span>' + esc(period || "—") + "</span></p>" +
          '<div class="issuer-name-row' + (seal ? " has-seal" : "") + '"><div>' +
            (profile.name.trim() ? '<p class="issuer-name">' + esc(profile.name.trim()) + "</p>" : "") +
            (issuerAddress.length ? "<p>" + escBr(issuerAddress.join("\n")) + "</p>" : "") +
            (profile.tel.trim() ? "<p>TEL " + esc(profile.tel.trim()) + "</p>" : "") +
            (profile.email.trim() ? "<p>MAIL " + esc(profile.email.trim()) + "</p>" : "") +
            (profile.invoiceRegNumber.trim() ? "<p>登録番号 " + esc(profile.invoiceRegNumber.trim()) + "</p>" : "") +
          "</div>" + (seal ? '<img class="seal-img" alt="" src="' + esc(seal) + '">' : "") +
          "</div></section></div>" +
        (draft.subject.trim() ? '<p class="subject">件名：' + esc(draft.subject.trim()) + "</p>" : "") +
        '<p class="greeting">下記の通り、ご請求申し上げます。</p>' +
        '<div class="grand"><span>' + (draft.withholding ? "差引ご請求金額" : "ご請求金額") + '</span><strong class="num" id="sheet-amount">' + esc(InvoiceCalc.formatAmountDue(result.amountDue)) + "</strong></div>" +
        '<p class="unit-note">単位：円</p>' +
        "<table><thead><tr><th>摘要</th><th class=\"num\">数量</th><th>単位</th><th class=\"num\">単価</th><th>税率</th><th class=\"num\">金額</th></tr></thead><tbody>" +
        itemRows + "</tbody></table>" +
        '<div class="summary" id="sheet-summary">' + rowsHTML(rows) + "</div>" +
        pay +
        (draft.notes.trim() ? '<section class="notes"><h2>備考</h2><p>' + escBr(draft.notes.trim()) + "</p></section>" : "") +
        (notes.length ? '<ul class="footnotes">' + notes.map((note) => "<li>" + esc(note) + "</li>").join("") + "</ul>" : "") +
      "</article>";

    const snapDiffers = !!(draft.useSnapshot && draft.profileSnapshot && stableProfile(draft.profileSnapshot) !== stableProfile(state.profile));
    $("#profile-banner").hidden = !!state.profile.name.trim();
    $("#snapshot-banner").hidden = !snapDiffers;
    const showDocActions = !!draft.id || hasUserContent(draft);
    $("#btn-duplicate").hidden = !showDocActions;
    $("#btn-delete-invoice").hidden = !draft.id;
  }

  function renderHistory() {
    const query = state.historyQuery.trim().toLowerCase();
    const filtered = state.invoices.filter((inv) => {
      if (state.historyFilter === "paid" && inv.status !== "paid") return false;
      if (state.historyFilter === "unpaid" && inv.status === "paid") return false;
      if (!query) return true;
      const blob = [inv.number, inv.subject, inv.client && inv.client.name, inv.client && inv.client.person, inv.notes].join(" ").toLowerCase();
      return blob.includes(query);
    }).sort((a, b) => String(b.issueDate || "").localeCompare(String(a.issueDate || "")) || String(b.number || "").localeCompare(String(a.number || "")));

    const unpaid = state.invoices.filter((inv) => inv.status !== "paid");
    const unpaidSum = unpaid.reduce((sum, inv) => sum + InvoiceCalc.calculate(inv, profileFor(inv)).amountDue, 0);
    $("#history-summary").textContent = unpaid.length
      ? "未入金 " + unpaid.length + "件　合計 " + InvoiceCalc.formatYen(unpaidSum)
      : "未入金はありません";
    document.querySelectorAll("#history-filter [data-filter]").forEach((button) => {
      button.classList.toggle("active", button.dataset.filter === state.historyFilter);
    });

    if (!state.invoices.length) {
      $("#history-list").innerHTML = '<p class="empty">まだ保存した請求書はありません。作成タブで入力して「保存」してください。</p>';
      return;
    }
    if (!filtered.length) {
      $("#history-list").innerHTML = '<p class="empty">該当する請求書はありません。</p>';
      return;
    }
    const today = todayISO();
    $("#history-list").innerHTML = filtered.map((inv) => {
      const amount = InvoiceCalc.calculate(inv, profileFor(inv)).amountDue;
      const overdue = inv.status !== "paid" && inv.dueDate && inv.dueDate < today;
      return (
        '<article class="inv-card" data-id="' + esc(inv.id) + '">' +
          "<div><div class=\"inv-title\">" + esc((inv.client && inv.client.name) || "（請求先なし）") + " " + esc((inv.client && inv.client.honorific) || "") + "</div>" +
          '<div class="inv-subject">' + esc(inv.subject || "件名なし") + "</div>" +
          '<div class="inv-meta"><span>' + esc(inv.number || "") + "</span><span>発行 " + esc(formatDateJP(inv.issueDate) || "—") + "</span>" +
          '<span class="' + (overdue ? "overdue" : "") + '">期限 ' + esc(formatDateJP(inv.dueDate) || "—") + (overdue ? "・超過" : "") + "</span></div></div>" +
          '<div class="inv-side"><div class="inv-amount">' + esc(InvoiceCalc.formatYen(amount)) + "</div>" +
          '<span class="badge ' + (inv.status === "paid" ? "paid" : "unpaid") + '">' + (inv.status === "paid" ? "入金済" : "未入金") + "</span>" +
          '<div class="inv-actions">' +
            '<button type="button" data-act="open">開く</button>' +
            '<button type="button" data-act="dup">複製</button>' +
            '<button type="button" data-act="status">' + (inv.status === "paid" ? "未入金に戻す" : "入金済みにする") + "</button>" +
            '<button type="button" data-act="del">削除</button>' +
          "</div></div></article>"
      );
    }).join("");
  }

  function renderClientAdmin() {
    const root = $("#client-admin");
    if (!state.clients.length) {
      root.innerHTML = '<p class="muted">まだありません。作成画面の「この請求先を登録」で追加できます。</p>';
      return;
    }
    root.innerHTML = state.clients.map((client) => (
      '<div class="client-row"><div><strong>' + esc(client.name) + '</strong><span class="muted">' + esc(client.honorific || "") +
      (client.person ? "・" + esc(client.person) : "") + "</span></div>" +
      '<button type="button" data-client-del="' + esc(client.id) + '">削除</button></div>'
    )).join("");
  }

  function saveInvoice() {
    readSimpleFields();
    state.draft.client.name = state.draft.client.name.trim();
    $("#f-client-name").value = state.draft.client.name;
    if (!state.draft.client.name) {
      switchView("edit");
      $("#f-client-name").focus();
      toast("請求先の名称を入力してください");
      return false;
    }
    if (!state.draft.items.some(isFilledItem)) {
      switchView("edit");
      toast("明細を1行以上入力してください");
      return false;
    }
    const now = new Date().toISOString();
    const record = healDraft(clone(state.draft));
    record.client.name = record.client.name.trim();
    record.items = record.items.filter(isFilledItem).map(healItem);
    record.profileSnapshot = clone(activeProfile());
    record.useSnapshot = true;
    record.updatedAt = now;
    record.createdAt = state.draft.createdAt || now;
    if (!record.id) record.id = uid();
    const index = state.invoices.findIndex((inv) => inv.id === record.id);
    if (index >= 0) state.invoices[index] = record;
    else state.invoices.push(record);
    state.draft = healDraft(clone(record));
    ensureBlankRow(state.draft);
    fillForm();
    renderLines();
    renderPreview();
    renderHistory();
    persist();
    toast("保存しました");
    return true;
  }

  function newInvoice() {
    if (isDirty() && !confirm("保存していない内容を破棄して、新しい請求書にしますか？")) return;
    state.draft = defaultDraft();
    state.draft.number = nextNumber(state.draft.issueDate);
    fillForm();
    renderLines();
    renderPreview();
    persist();
    switchView("edit");
    $("#f-client-name").focus();
  }

  function duplicateInvoice(source) {
    const copy = healDraft(clone(source));
    copy.id = null;
    copy.status = "unpaid";
    copy.createdAt = null;
    copy.updatedAt = null;
    copy.useSnapshot = false;
    copy.profileSnapshot = null;
    copy.issueDate = todayISO();
    copy.dueDate = monthEnd(copy.issueDate, 1);
    copy.number = nextNumber(copy.issueDate);
    ensureBlankRow(copy);
    state.draft = copy;
    fillForm();
    renderLines();
    renderPreview();
    persist();
    switchView("edit");
    toast("複製しました。番号と日付は今日にしています。");
  }

  function deleteInvoice(id) {
    const inv = state.invoices.find((item) => item.id === id);
    if (!inv) return;
    const label = inv.number || (inv.client && inv.client.name) || "この請求書";
    if (!confirm("「" + label + "」を削除しますか？この操作は元に戻せません。")) return;
    state.invoices = state.invoices.filter((item) => item.id !== id);
    if (state.draft.id === id) {
      state.draft = defaultDraft();
      state.draft.number = nextNumber(state.draft.issueDate);
      fillForm();
      renderLines();
    }
    persist();
    renderHistory();
    renderPreview();
    toast("削除しました");
  }

  function openInvoice(id) {
    if (state.draft.id === id && !isDirty()) {
      switchView("edit");
      return;
    }
    if (isDirty() && !confirm("保存していない内容を破棄して、選んだ請求書を開きますか？")) return;
    const inv = state.invoices.find((item) => item.id === id);
    if (!inv) return;
    state.draft = healDraft(clone(inv));
    ensureBlankRow(state.draft);
    fillForm();
    renderLines();
    renderPreview();
    persist();
    switchView("edit");
  }

  function openMail() {
    readSimpleFields();
    const draft = state.draft;
    const result = InvoiceCalc.calculate(draft, activeProfile());
    const profile = activeProfile();
    const honor = draft.client.honorific || "御中";
    const who = (draft.client.name.trim() + " " + honor).trim();
    const body = [
      who,
      "",
      "お世話になっております。",
      "請求書をお送りします。PDFを添付しています。",
      "",
      "請求書番号: " + (draft.number || ""),
      draft.subject.trim() ? "件名: " + draft.subject.trim() : null,
      "ご請求金額: " + InvoiceCalc.formatYen(result.amountDue),
      draft.dueDate ? "お支払期限: " + formatDateJP(draft.dueDate) : null,
      "",
      "ご確認のほど、よろしくお願いいたします。",
      "",
      profile.name.trim(),
    ].filter((line) => line !== null).join("\n");
    const subject = ("請求書 " + (draft.number || "") + " " + draft.subject.trim()).trim();
    window.location.href = "mailto:" + (draft.client.email.trim() || "") + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: state.profile,
      clients: state.clients,
      invoices: state.invoices,
      draft: state.draft,
    }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = "請求書データ_" + todayISO() + ".json";
    link.click();
    URL.revokeObjectURL(url);
  }

  function importData(data) {
    if (!data || data.version !== 1 || !data.profile || !Array.isArray(data.invoices)) {
      toast("読み込めないファイルです");
      return;
    }
    if (!confirm("いまのデータを、読み込んだファイルの内容で置き換えます。よろしいですか？")) return;
    state.profile = { ...defaultProfile(), ...data.profile };
    state.clients = Array.isArray(data.clients) ? data.clients.map(healClient) : [];
    state.invoices = data.invoices.map(healDraft);
    state.draft = data.draft ? healDraft(data.draft) : defaultDraft();
    ensureBlankRow(state.draft);
    if (!state.draft.number) state.draft.number = nextNumber(state.draft.issueDate);
    fillProfile();
    fillForm();
    renderLines();
    renderClientAdmin();
    renderHistory();
    renderPreview();
    fillSealPreview();
    persist();
    toast("読み込みました");
  }

  function setDue(iso) {
    state.draft.dueDate = iso;
    $("#f-due").value = iso;
    renderPreview();
    schedulePersist();
  }

  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        const max = 360;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/png"));
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("image"));
      };
      image.src = url;
    });
  }

  function bind() {
    document.querySelector("nav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-view]");
      if (button) switchView(button.dataset.view);
    });
    document.body.addEventListener("click", (event) => {
      const jump = event.target.closest("[data-view-jump]");
      if (jump) switchView(jump.dataset.viewJump);
    });

    $("#editor").addEventListener("input", (event) => {
      if (event.target.closest(".line")) return;
      readSimpleFields();
      if (event.target.id === "f-withholding") {
        syncWithholdingUI();
        renderLines();
      }
      renderPreview();
      schedulePersist();
    });
    $("#editor").addEventListener("change", (event) => {
      if (event.target.closest(".line")) return;
      if (event.target.id === "f-status" || event.target.id === "f-honorific" || event.target.id === "f-fee") {
        readSimpleFields();
        renderPreview();
        schedulePersist();
      }
    });

    const lines = $("#lines");
    lines.addEventListener("input", (event) => {
      const row = event.target.closest(".line");
      if (!row) return;
      readLine(row);
      renderPreview();
      schedulePersist();
    });
    lines.addEventListener("change", (event) => {
      const row = event.target.closest(".line");
      if (!row) return;
      readLine(row);
      renderPreview();
      schedulePersist();
    });
    lines.addEventListener("focusin", (event) => {
      if (event.target.classList.contains("line-qty") || event.target.classList.contains("line-price")) event.target.select();
    });
    lines.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || !event.target.classList.contains("line-desc")) return;
      const row = event.target.closest(".line");
      readLine(row);
      const last = state.draft.items[state.draft.items.length - 1];
      if (row.dataset.id !== last.id) return;
      event.preventDefault();
      addLine();
      renderPreview();
      schedulePersist();
    });
    lines.addEventListener("click", (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const row = button.closest(".line");
      readLine(row);
      const index = state.draft.items.findIndex((item) => item.id === row.dataset.id);
      if (index < 0) return;
      if (button.dataset.act === "del") {
        if (state.draft.items.length === 1) state.draft.items[0] = blankItem();
        else state.draft.items.splice(index, 1);
      } else if (button.dataset.act === "up" && index > 0) {
        const swapped = state.draft.items[index - 1];
        state.draft.items[index - 1] = state.draft.items[index];
        state.draft.items[index] = swapped;
      } else if (button.dataset.act === "down" && index < state.draft.items.length - 1) {
        const swapped = state.draft.items[index + 1];
        state.draft.items[index + 1] = state.draft.items[index];
        state.draft.items[index] = swapped;
      } else return;
      renderLines();
      renderPreview();
      schedulePersist();
    });

    $("#btn-add-line").addEventListener("click", () => {
      addLine();
      renderPreview();
      schedulePersist();
    });
    $("#btn-renumber").addEventListener("click", () => {
      readSimpleFields();
      state.draft.number = nextNumber(state.draft.issueDate);
      $("#f-number").value = state.draft.number;
      renderPreview();
      schedulePersist();
    });
    $("#btn-due-eom").addEventListener("click", () => setDue(monthEnd($("#f-issue").value || todayISO(), 0)));
    $("#btn-due-next").addEventListener("click", () => setDue(monthEnd($("#f-issue").value || todayISO(), 1)));
    $("#btn-due-30").addEventListener("click", () => setDue(addDays($("#f-issue").value || todayISO(), 30)));
    $("#btn-save-client").addEventListener("click", () => {
      readSimpleFields();
      const name = state.draft.client.name.trim();
      if (!name) {
        toast("請求先の名称を入力してください");
        return;
      }
      state.draft.client.name = name;
      $("#f-client-name").value = name;
      const existing = state.clients.find((client) => client.name === name);
      const record = healClient({ ...(existing || {}), ...state.draft.client, id: existing ? existing.id : uid(), name });
      if (existing) Object.assign(existing, record);
      else state.clients.push(record);
      refreshClientSelect();
      renderClientAdmin();
      persist();
      toast("請求先を登録しました");
    });
    $("#client-pick").addEventListener("change", () => {
      const client = state.clients.find((item) => item.id === $("#client-pick").value);
      if (!client) return;
      state.draft.client = { ...defaultClient(), ...client };
      fillForm();
      renderPreview();
      schedulePersist();
    });
    $("#btn-save").addEventListener("click", saveInvoice);
    $("#btn-new").addEventListener("click", newInvoice);
    $("#btn-print").addEventListener("click", () => window.print());
    $("#btn-print-2").addEventListener("click", () => window.print());
    $("#btn-mail").addEventListener("click", openMail);
    $("#btn-duplicate").addEventListener("click", () => {
      if (!state.draft.id) {
        if (!saveInvoice()) return;
      } else if (isDirty() && !confirm("保存前の変更は複製側に移ります。元の請求書は、最後に保存した内容のままです。続けますか？")) {
        return;
      }
      duplicateInvoice(state.draft);
    });
    $("#btn-delete-invoice").addEventListener("click", () => {
      if (state.draft.id) deleteInvoice(state.draft.id);
    });
    $("#btn-refresh-profile").addEventListener("click", () => {
      state.draft.profileSnapshot = clone(state.profile);
      state.draft.useSnapshot = true;
      renderPreview();
      schedulePersist();
      toast("用紙の自社情報を差し替えました。保存すると確定します。");
    });

    $("#view-settings").addEventListener("input", (event) => {
      if (event.target.id === "p-seal") return;
      readProfileFromForm();
      updateRegWarning();
      renderPreview();
      schedulePersist();
    });
    $("#view-settings").addEventListener("change", (event) => {
      if (event.target.id === "p-rounding" || event.target.id === "p-account-type") {
        readProfileFromForm();
        renderPreview();
        schedulePersist();
      }
    });
    $("#p-zip").addEventListener("blur", () => {
      $("#p-zip").value = formatZip($("#p-zip").value);
      readProfileFromForm();
      renderPreview();
      schedulePersist();
    });
    $("#p-reg").addEventListener("blur", () => {
      $("#p-reg").value = $("#p-reg").value.trim().toUpperCase();
      readProfileFromForm();
      updateRegWarning();
      renderPreview();
      schedulePersist();
    });
    $("#f-client-zip").addEventListener("blur", () => {
      $("#f-client-zip").value = formatZip($("#f-client-zip").value);
      state.draft.client.zip = $("#f-client-zip").value;
      renderPreview();
      schedulePersist();
    });
    $("#p-seal").addEventListener("change", async () => {
      const file = $("#p-seal").files && $("#p-seal").files[0];
      $("#p-seal").value = "";
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        toast("画像ファイルを選んでください");
        return;
      }
      try {
        state.profile.sealImage = await shrinkImage(file);
        fillSealPreview();
        renderPreview();
        persist();
        toast("印影を設定しました");
      } catch (_) {
        toast("画像を読み込めませんでした");
      }
    });
    $("#btn-seal-clear").addEventListener("click", () => {
      state.profile.sealImage = "";
      fillSealPreview();
      renderPreview();
      persist();
    });
    $("#client-admin").addEventListener("click", (event) => {
      const button = event.target.closest("[data-client-del]");
      if (!button) return;
      const client = state.clients.find((item) => item.id === button.dataset.clientDel);
      if (!client) return;
      if (!confirm("「" + client.name + "」を請求先リストから削除しますか？保存済みの請求書はそのまま残ります。")) return;
      state.clients = state.clients.filter((item) => item.id !== client.id);
      refreshClientSelect();
      renderClientAdmin();
      persist();
      toast("削除しました");
    });

    $("#history-search").addEventListener("input", (event) => {
      state.historyQuery = event.target.value;
      renderHistory();
    });
    $("#history-filter").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.historyFilter = button.dataset.filter;
      renderHistory();
    });
    $("#history-list").addEventListener("click", (event) => {
      const card = event.target.closest(".inv-card");
      if (!card) return;
      const id = card.dataset.id;
      const act = event.target.closest("[data-act]")?.dataset.act || "open";
      if (act === "open") openInvoice(id);
      else if (act === "dup") {
        const inv = state.invoices.find((item) => item.id === id);
        if (!inv) return;
        if (isDirty() && !confirm("保存していない内容を破棄して複製を開きますか？")) return;
        duplicateInvoice(inv);
      } else if (act === "status") {
        const inv = state.invoices.find((item) => item.id === id);
        if (!inv) return;
        inv.status = inv.status === "paid" ? "unpaid" : "paid";
        if (state.draft.id === id) {
          state.draft.status = inv.status;
          $("#f-status").value = inv.status;
        }
        persist();
        renderHistory();
      } else if (act === "del") deleteInvoice(id);
    });

    $("#btn-export").addEventListener("click", exportData);
    $("#btn-import").addEventListener("click", () => $("#import-file").click());
    $("#import-file").addEventListener("change", () => {
      const file = $("#import-file").files && $("#import-file").files[0];
      $("#import-file").value = "";
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try { importData(JSON.parse(String(reader.result))); }
        catch (_) { toast("JSONとして読めませんでした"); }
      };
      reader.readAsText(file);
    });

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveInvoice();
      }
    });
  }

  load();
  bind();
  fillProfile();
  fillSealPreview();
  fillForm();
  renderLines();
  renderClientAdmin();
  renderHistory();
  renderPreview();
  switchView("edit");
})();
