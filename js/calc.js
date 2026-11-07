(function (root) {
  function parseNum(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    const n = Number(String(value ?? "").replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }

  function yenRound(value) {
    return Math.round(value);
  }

  // 税率ごとの税抜合計に対して1回だけ端数処理する。
  function roundTax(base, ratePercent, mode) {
    const roundedBase = yenRound(base);
    const sign = roundedBase < 0 ? -1 : 1;
    const num = Math.abs(roundedBase) * ratePercent;
    let yen;
    if (mode === "ceil") yen = Math.ceil(num / 100);
    else if (mode === "round") yen = Math.round(num / 100);
    else yen = Math.floor(num / 100);
    return sign * yen;
  }

  function withholdingRateOf(value) {
    if (value === "" || value == null) return 10.21;
    const n = Number(value);
    return Number.isFinite(n) ? n : 10.21;
  }

  // 源泉徴収の1円未満は切り捨て。
  function withholdingAmount(base, rate) {
    if (base <= 0) return 0;
    const milli = Math.round(rate * 1000);
    return Math.floor(base * milli / 100000);
  }

  function calculate(draft, profile) {
    const mode = (profile && profile.taxRounding) || "floor";
    const items = [];
    const byRate = { 10: 0, 8: 0, 0: 0 };
    let withholdingBase = 0;

    for (const raw of (draft && draft.items) || []) {
      const description = String(raw.description || "").trim();
      const unitPrice = parseNum(raw.unitPrice);
      const qty = parseNum(raw.qty);
      if (!description && !unitPrice) continue;
      const taxRate = raw.taxRate === "8" || raw.taxRate === 8 ? 8 : (raw.taxRate === "0" || raw.taxRate === 0 ? 0 : 10);
      const amount = yenRound(qty * unitPrice);
      const withhold = !!(draft.withholding && raw.withhold !== false);
      items.push({
        description,
        qty,
        unit: raw.unit || "",
        unitPrice,
        taxRate,
        amount,
        withhold,
      });
      byRate[taxRate] += amount;
      if (withhold) withholdingBase += amount;
    }

    const tax = {
      10: roundTax(byRate[10], 10, mode),
      8: roundTax(byRate[8], 8, mode),
      0: 0,
    };
    const subtotal = byRate[10] + byRate[8] + byRate[0];
    const taxTotal = tax[10] + tax[8];
    const total = subtotal + taxTotal;
    const rate = withholdingRateOf(draft && draft.withholdingRate);
    const withholding = draft && draft.withholding ? withholdingAmount(withholdingBase, rate) : 0;

    return {
      items,
      byRate,
      tax,
      subtotal,
      taxTotal,
      total,
      withholdingBase,
      withholding,
      amountDue: total - withholding,
      withholdingRate: rate,
    };
  }

  function formatComma(value) {
    return Math.round(value).toLocaleString("ja-JP");
  }

  function formatAccount(value) {
    const rounded = Math.round(value);
    const body = Math.abs(rounded).toLocaleString("ja-JP");
    return rounded < 0 ? "▲" + body : body;
  }

  function formatYen(value) {
    const rounded = Math.round(value);
    const sign = rounded < 0 ? "-" : "";
    return sign + "¥" + Math.abs(rounded).toLocaleString("ja-JP");
  }

  function formatAmountDue(value) {
    const rounded = Math.round(value);
    if (rounded < 0) return "-" + "¥" + Math.abs(rounded).toLocaleString("ja-JP");
    return "¥" + rounded.toLocaleString("ja-JP") + "-";
  }

  const api = {
    parseNum,
    calculate,
    formatComma,
    formatAccount,
    formatYen,
    formatAmountDue,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InvoiceCalc = api;

  if (typeof module !== "undefined" && require.main === module) {
    const assert = (cond, msg) => {
      if (!cond) {
        console.error("FAIL", msg);
        process.exitCode = 1;
      }
    };

    const mixed = calculate({
      withholding: false,
      items: [
        { description: "デザイン", qty: 1, unitPrice: 100000, taxRate: "10" },
        { description: "書籍", qty: 2, unitPrice: 1000, taxRate: "8" },
        { description: "", qty: 1, unitPrice: "", taxRate: "10" },
      ],
    });
    assert(mixed.subtotal === 102000, "mixed subtotal");
    assert(mixed.tax[10] === 10000, "tax 10");
    assert(mixed.tax[8] === 160, "tax 8");
    assert(mixed.total === 112160, "mixed total");
    assert(mixed.items.length === 2, "blank line dropped");

    const withheld = calculate({
      withholding: true,
      withholdingRate: 10.21,
      items: [
        { description: "デザイン", qty: 1, unitPrice: 100000, taxRate: "10", withhold: true },
        { description: "交通費", qty: 1, unitPrice: 2000, taxRate: "10", withhold: false },
      ],
    });
    assert(withheld.withholdingBase === 100000, "withholding base excludes expenses");
    assert(withheld.withholding === 10210, "withholding 10.21%");
    assert(withheld.total === 112200, "withheld total");
    assert(withheld.amountDue === 101990, "amount due");

    const partial = calculate({
      withholding: true,
      withholdingRate: 10.21,
      items: [{ description: "報酬", qty: 1, unitPrice: 33333, taxRate: "10" }],
    });
    assert(partial.withholding === 3403, "withholding truncates yen");

    const discount = calculate({
      items: [{ description: "値引", qty: 1, unitPrice: -500, taxRate: "10" }],
    });
    assert(discount.tax[10] === -50, "negative tax toward zero");

    const rounded = calculate(
      { items: [{ description: "端数", qty: 1, unitPrice: 1005, taxRate: "10" }] },
      { taxRounding: "round" }
    );
    const ceiled = calculate(
      { items: [{ description: "端数", qty: 1, unitPrice: 1005, taxRate: "10" }] },
      { taxRounding: "ceil" }
    );
    assert(rounded.tax[10] === 101, "round half up");
    assert(ceiled.tax[10] === 101, "ceil");
    assert(calculate({ items: [{ description: "端数", qty: 1, unitPrice: 1005, taxRate: "10" }] }).tax[10] === 100, "floor default");

    const hours = calculate({
      items: [{ description: "作業", qty: 1.5, unitPrice: 2000, taxRate: "10" }],
    });
    assert(hours.items[0].amount === 3000, "decimal qty");

    if (!process.exitCode) console.log("calc ok");
  }
})(typeof window !== "undefined" ? window : globalThis);
