const express = require("express");
const qs = require("qs");
const multer = require('multer');
const cloudscraper = require("cloudscraper");
const upload = multer();
const app = express();
const router = express.Router();
app.use(express.urlencoded({
  extended: true
}));
app.use(express.json());

const domain = process.env.PTERO_DOMAIN;
const apikey = process.env.PTERO_API_KEY;

const {
  requireLogin,
  User,
  tambahHistoryDeposit,
  generateReffId,
  BASE_URL,
  ATLAN_API_KEY,
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
} = require("../index.js");

const cloudscraperHeaders = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
};

async function getAtlanticDepositMethods() {
  try {
    const formData = {
      api_key: process.env.ATLAN_API_KEY,
    };
    const response = await cloudscraper.post(`${BASE_URL}/deposit/metode`, {
      body: qs.stringify(formData),
      headers: cloudscraperHeaders,
    });
    const result = JSON.parse(response);
    if (result && result.status && Array.isArray(result.data)) {
      return result.data;
    }
    return null;
  } catch (error) {
    console.error("Gagal mengambil metode deposit dari Atlantic:", error?.response?.data || error.message);
    return null;
  }
}


// ================= HELPER DITZNESIA =================
const DITZNESIA_BG_IMAGE = "https://files.catbox.moe/mbhgwo.png";

function getDitznesiaConfig() {
  const baseUrl = (process.env.DITZNESIA_BASE_URL || "https://www.ditznesia.com/api/dev").replace(/\/+$/, "");
  const apiKey = process.env.DITZNESIA_API_KEY || "";
  return { baseUrl, apiKey };
}

function extractDitznesiaPayload(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) {
    return raw.data;
  }
  if (raw.deposit && typeof raw.deposit === "object") {
    return raw.deposit;
  }
  return raw;
}

function normalizeDitznesiaStatus(rawStatus, fallback = "pending") {
  const s = String(rawStatus || fallback).toLowerCase().trim();
  if (["success", "paid", "completed", "berhasil", "lunas"].includes(s)) {
    return "success";
  }
  if (["failed", "gagal"].includes(s)) {
    return "failed";
  }
  if (["expired", "kadaluarsa"].includes(s)) {
    return "expired";
  }
  if (["cancel", "cancelled", "canceled", "batal", "dibatalkan"].includes(s)) {
    return "cancel";
  }
  return s || fallback;
}

function parseIsoTimestamp(val) {
  if (!val) return null;
  if (typeof val === "number") {
    const ms = val < 1e12 ? val * 1000 : val;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(val));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchDitznesiaGet(endpointPath, params = {}, timeoutMs = 10000) {
  const { baseUrl, apiKey } = getDitznesiaConfig();
  const url = new URL(`${baseUrl}${endpointPath}`);
  url.searchParams.set("apikey", apiKey);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      signal: controller.signal
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`Response Ditznesia bukan JSON valid: ${text.slice(0, 300)}`);
    }

    return { ok: res.ok, statusCode: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function calculateUserFeeAndBalance(baseBalance, role, providerFee = 0) {
  const cleanBase = Math.max(0, parseInt(baseBalance, 10) || 0);
  const cleanProviderFee = Math.max(0, parseInt(providerFee, 10) || 0);

  let additionalFee = 0;
  if (role === "user") {
    additionalFee = Math.ceil(cleanBase * 0.002);
  } else if (role === "reseller") {
    additionalFee = Math.ceil(cleanBase * 0.001);
  }

  const totalFee = cleanProviderFee + additionalFee;
  const finalBalance = Math.max(0, cleanBase - additionalFee);

  return {
    additionalFee,
    totalFee,
    finalBalance
  };
}

// ================= LIST METODE DEPOSIT (DITZNESIA) =================
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const { apiKey } = getDitznesiaConfig();
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "API Key Ditznesia belum dikonfigurasi di server."
      });
    }

    const role = req.session.role || "user";
    let tambahanPersen = 0;
    if (role === "user") tambahanPersen = 1.5;
    if (role === "reseller") tambahanPersen = 0.7;

    // Default metode QRIS Ditznesia (tetap kompatibel dengan format frontend sebelumnya)
    let rawMethods = [
      {
        metode: "QRISFAST",
        type: "ewallet",
        name: "QRIS Otomatis (All Payment)",
        min: 500,
        max: 5000000,
        fee: 0,
        fee_persen: 0,
        status: "aktif"
      }
    ];

    // Opsional: jika Ditznesia menyediakan endpoint /deposit/metode, ambil & gabungkan
    try {
      const { ok, json } = await fetchDitznesiaGet("/deposit/metode", {}, 5000);
      const listFromApi = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.metode)
        ? json.metode
        : null;

      if (ok && listFromApi && listFromApi.length > 0) {
        rawMethods = listFromApi;
      }
    } catch (_) {
      // Gunakan fallback metode QRIS Ditznesia jika endpoint /deposit/metode tidak tersedia
    }

    const blacklist = ["OVO", "DANA", "MANDIRI", "PERMATA"];
    const localImageMap = {
      BCA: "/media/metode/bca.png",
      BRI: "/media/metode/bri.png",
      BNI: "/media/metode/bni.png",
      SHOPEEPAY: "/media/metode/shopeepay.png",
      LINKAJA: "/media/metode/linkaja.png",
      QRIS: "/media/metode/qrisfast.png",
      QRISFAST: "/media/metode/qrisfast.png"
    };
    const fullUrl = `${req.protocol}://${req.get("host")}`;

    const metodeFormatted = rawMethods
      .filter((item) => !blacklist.includes(String(item.metode || "").toUpperCase()))
      .map((item) => {
        const metodeUpper = String(item.metode || "QRISFAST").toUpperCase();
        const baseFee = parseFloat(item.fee_persen) || 0;
        const adjustedFee = (baseFee + tambahanPersen).toFixed(2);

        return {
          metode: item.metode || "QRISFAST",
          type: item.type || "ewallet",
          name: item.name || "QRIS Otomatis",
          min: item.min || 1000,
          max: item.max || 5000000,
          fee: item.fee || 0,
          fee_persen: adjustedFee,
          status: item.status || "aktif",
          img_url: localImageMap[metodeUpper]
            ? `${fullUrl}${localImageMap[metodeUpper]}`
            : `${fullUrl}/media/metode/default.png`
        };
      });

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit berhasil difilter",
      metode: metodeFormatted
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil metode deposit",
      error: error?.response?.data || error.message
    });
  }
});

// ================= HELPER DITZNESIA =================
const DITZNESIA_BG_IMAGE = "https://files.catbox.moe/mbhgwo.png";

function getDitznesiaConfig() {
  const baseUrl = (process.env.DITZNESIA_BASE_URL || "https://www.ditznesia.com/api/dev").replace(/\/+$/, "");
  const apiKey = process.env.DITZNESIA_API_KEY || "";
  return { baseUrl, apiKey };
}

function extractDitznesiaPayload(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) {
    return raw.data;
  }
  if (raw.deposit && typeof raw.deposit === "object") {
    return raw.deposit;
  }
  return raw;
}

function normalizeDitznesiaStatus(rawStatus, fallback = "pending") {
  const s = String(rawStatus || fallback).toLowerCase().trim();
  if (["success", "paid", "completed", "berhasil", "lunas"].includes(s)) {
    return "success";
  }
  if (["failed", "gagal"].includes(s)) {
    return "failed";
  }
  if (["expired", "kadaluarsa"].includes(s)) {
    return "expired";
  }
  if (["cancel", "cancelled", "canceled", "batal", "dibatalkan"].includes(s)) {
    return "cancelled";
  }
  return s || fallback;
}

function parseIsoTimestamp(val) {
  if (!val) return null;
  if (typeof val === "number") {
    const ms = val < 1e12 ? val * 1000 : val;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(val));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchDitznesiaGet(endpointPath, params = {}, timeoutMs = 10000) {
  const { baseUrl, apiKey } = getDitznesiaConfig();
  const url = new URL(`${baseUrl}${endpointPath}`);
  url.searchParams.set("apikey", apiKey);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      signal: controller.signal
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`Response Ditznesia bukan JSON valid: ${text.slice(0, 300)}`);
    }

    return { ok: res.ok, statusCode: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hitung admin API Ditznesia + admin aplikasi (role) secara konsisten.
 * - nominal: nominal deposit murni user (misal 1000)
 * - kodeUnik: angka unik 1..250 (misal 79)
 * - apiData: objek payload dari Ditznesia
 * - role: "user" | "reseller" | dll
 */
function calculateDepositBreakdown({ nominal, kodeUnik = 0, apiData = {}, role = "user" }) {
  const baseNominal = Math.max(0, parseInt(nominal, 10) || 0);
  const uniqueCode = Math.max(0, parseInt(kodeUnik, 10) || 0);

  // Admin / fee yang berasal dari response API Ditznesia
  const apiFee = Math.max(
    0,
    parseInt(apiData.fee ?? apiData.fee_amount ?? apiData.biaya_admin ?? 0, 10) || 0
  );

  // Admin tambahan dari sistem/kode sendiri (bisa diubah sesuai kebutuhan)
  let appAdminFee = 0;
  if (role === "user") {
    appAdminFee = Math.ceil(baseNominal * 0.002); // 0.2% -> 1000 jadi 3
  } else if (role === "reseller") {
    appAdminFee = Math.ceil(baseNominal * 0.001); // 0.1%
  }

  // Total biaya admin yang ditampilkan ke user (API + kode)
  const totalAdminFee = apiFee + appAdminFee;

  // Total pembayaran: jika API mengembalikan total_bayar / total_payment, pakai itu;
  // jika tidak, hitung dari nominal + kodeUnik + apiFee
  const rawApiTotalBayar = parseInt(
    apiData.total_bayar ?? apiData.total_payment ?? 0,
    10
  );
  const totalBayar =
    rawApiTotalBayar > 0
      ? rawApiTotalBayar
      : baseNominal + uniqueCode + apiFee;

  // Saldo diterima user: dipotong admin aplikasi (appAdminFee), tidak pernah melebihi baseNominal
  const saldoDiterima = Math.max(0, baseNominal - appAdminFee);

  return {
    nominal: baseNominal,
    kode_unik: uniqueCode,
    tambahan: uniqueCode,
    fee_provider: apiFee,
    fee_app: appAdminFee,
    fee_env: appAdminFee,
    fee: totalAdminFee,
    total_amount: totalBayar,
    total_bayar: totalBayar,
    get_balance: saldoDiterima
  };
}

// ================= BUAT TRANSAKSI DEPOSIT (DITZNESIA) =================
router.post("/deposit/create", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    const { nominal } = req.body;
    const parsedNominal = parseInt(nominal, 10);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    if (!nominal || !Number.isFinite(parsedNominal) || parsedNominal < 100) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp100"
      });
    }

    const { apiKey } = getDitznesiaConfig();
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "API Key Ditznesia belum dikonfigurasi di server."
      });
    }

    // ================= KODE UNIK & REQUEST KE DITZNESIA =================
    const kodeUnik = Math.floor(Math.random() * 250) + 1; // Nilai Rp1 - Rp250
    const requestNominalToApi = parsedNominal + kodeUnik;

    let apiResult;
    try {
      apiResult = await fetchDitznesiaGet("/deposit/create", {
        nominal: requestNominalToApi
      });
    } catch (fetchError) {
      console.error("Ditznesia Create Fetch Error:", fetchError);
      return res.status(502).json({
        success: false,
        message: "Koneksi server ke Ditznesia gagal."
      });
    }

    const { ok, json: result } = apiResult;
    const paymentData = extractDitznesiaPayload(result);

    const isApiSuccess =
      ok &&
      result?.success !== false &&
      result?.status !== false &&
      Boolean(paymentData?.id || paymentData?.invoice_id || paymentData?.trx_id);

    if (!isApiSuccess) {
      return res.status(400).json({
        success: false,
        message:
          result?.message ||
          result?.error ||
          paymentData?.message ||
          "Gagal membuat QRIS Ditznesia."
      });
    }

    const rawQrImage =
      paymentData.qr_link ||
      paymentData.qr_image ||
      paymentData.qris_url ||
      paymentData.qris_code_url ||
      "";
    const qrisString =
      paymentData.qr_string ||
      paymentData.qris_string ||
      paymentData.qr_code ||
      paymentData.pay_url ||
      "";

    const providerPaymentId = String(
      paymentData.id || paymentData.invoice_id || paymentData.trx_id
    );
    const localTrxId = providerPaymentId;

    const providerCreatedAt =
      parseIsoTimestamp(paymentData.created_at) || new Date().toISOString();
    const providerExpiresAt =
      parseIsoTimestamp(
        paymentData.expired_at ||
          paymentData.expires_at ||
          paymentData.expired_at_ms ||
          paymentData.expires_at_ms
      ) || null;

    if (!rawQrImage && !qrisString) {
      return res.status(502).json({
        success: false,
        message: "Ditznesia tidak mengembalikan data QRIS yang lengkap."
      });
    }

    const breakdown = calculateDepositBreakdown({
      nominal: parsedNominal,
      kodeUnik,
      apiData: paymentData,
      role: user.role || req.session.role || "user"
    });

    const initialStatus = normalizeDitznesiaStatus(paymentData.status, "pending");
    const customBgUrl = "https://files.catbox.moe/mbhgwo.png";

    // ================= SIMPAN HISTORY =================
    const historyDataForDb = {
      id: localTrxId,
      reff_id: String(paymentData.trx_id || localTrxId),
      nominal: breakdown.nominal,
      tambahan: breakdown.tambahan,
      kode_unik: breakdown.kode_unik,
      fee: breakdown.fee,
      fee_env: breakdown.fee_env,
      fee_app: breakdown.fee_app,
      fee_provider: breakdown.fee_provider,
      total_amount: breakdown.total_amount,
      total_bayar: breakdown.total_bayar,
      get_balance: breakdown.get_balance,
      provider_amount: Number(paymentData.amount ?? breakdown.total_amount) || breakdown.total_amount,
      provider: "ditznesia",
      provider_id: providerPaymentId,
      provider_reference_id: String(paymentData.trx_id || localTrxId),
      provider_created_at: providerCreatedAt,
      provider_expires_at: providerExpiresAt,
      expires_in_ms: 15 * 60 * 1000,
      provider_status: initialStatus,
      provider_time: null,
      qris_string: qrisString,
      metode: "QRIS",
      status: initialStatus,
      qr_image: rawQrImage || null,
      bg_image: customBgUrl,
      created_at: new Date()
    };

    await tambahHistoryDeposit(user._id, historyDataForDb);

    res.status(200).json({
      success: true,
      data: {
        id: localTrxId,
        trx_id: localTrxId,
        reff_id: String(paymentData.trx_id || localTrxId),
        metode: "QRIS",
        nominal: breakdown.nominal,
        kode_unik: breakdown.kode_unik,
        tambahan: breakdown.tambahan,
        fee: breakdown.fee,
        fee_env: breakdown.fee_env,
        fee_app: breakdown.fee_app,
        fee_provider: breakdown.fee_provider,
        total_amount: breakdown.total_amount,
        total_bayar: breakdown.total_bayar,
        get_balance: breakdown.get_balance,
        qr_image: rawQrImage || null,
        qris_string: qrisString,
        bg_image: customBgUrl,
        status: initialStatus,
        expires_at: providerExpiresAt,
        expires_in_ms: 15 * 60 * 1000
      }
    });

    // ================= BACKGROUND POLLING DITZNESIA (TIAP 3 DETIK) =================
    const POLL_INTERVAL_MS = 3000;
    const MAX_POLL_DURATION_MS = 15 * 60 * 1000 + 60000;

    const intervalId = setInterval(async () => {
      try {
        const latestHistory = await User.findOne(
          { _id: user._id, "historyDeposit.id": localTrxId },
          { "historyDeposit.$": 1 }
        );

        const latestDeposit = latestHistory?.historyDeposit?.[0];
        const localStatus = String(latestDeposit?.status || "").toLowerCase();

        if (!latestDeposit || !["pending", "processing"].includes(localStatus)) {
          clearInterval(intervalId);
          return;
        }

        const targetId = latestDeposit.provider_id || localTrxId;
        const { ok: checkOk, json: checkData } = await fetchDitznesiaGet(
          "/deposit/status",
          { id: targetId },
          8000
        );

        if (!checkOk) return;

        const providerTrx = extractDitznesiaPayload(checkData);
        const providerStatus = normalizeDitznesiaStatus(providerTrx?.status, "");

        if (!providerStatus) return;

        const pTime =
          parseIsoTimestamp(
            providerTrx.settlement_time ||
              providerTrx.paid_at ||
              providerTrx.updated_at ||
              providerTrx.created_at
          ) || null;

        if (providerStatus === "success") {
          const creditAmount = Number(latestDeposit.get_balance) || 0;

          const updateResult = await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: localTrxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": "success",
                "historyDeposit.$.provider_id": String(
                  providerTrx.id || providerTrx.invoice_id || targetId
                ),
                "historyDeposit.$.provider_reference_id": String(
                  providerTrx.trx_id || localTrxId
                ),
                "historyDeposit.$.provider_amount":
                  Number(
                    providerTrx.total_bayar ??
                      providerTrx.amount ??
                      latestDeposit.total_amount
                  ) || 0,
                "historyDeposit.$.provider_status": "success",
                "historyDeposit.$.provider_time": pTime
              },
              $inc: {
                saldo: creditAmount
              }
            }
          );

          if (updateResult.modifiedCount > 0) {
            console.log(`Deposit Ditznesia SUCCESS ${localTrxId} (+Rp${creditAmount})`);
          }
          clearInterval(intervalId);
          return;
        }

        if (["failed", "expired", "cancelled"].includes(providerStatus)) {
          await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: localTrxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": providerStatus,
                "historyDeposit.$.provider_status": providerStatus,
                "historyDeposit.$.provider_time": pTime
              }
            }
          );
          clearInterval(intervalId);
        }
      } catch (e) {
        console.error("Ditznesia Polling Error:", e.message);
      }
    }, POLL_INTERVAL_MS);

    setTimeout(() => clearInterval(intervalId), MAX_POLL_DURATION_MS);
  } catch (err) {
    console.error("Deposit Create Error:", err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: err.message
      });
    }
  }
});

// ================= CEK STATUS DEPOSIT (DITZNESIA) =================
router.post("/deposit/status", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sesi tidak valid."
      });
    }

    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "ID diperlukan."
      });
    }

    let userWithHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userWithHistory?.historyDeposit?.length) {
      return res.status(404).json({
        success: false,
        message: "Data tidak ditemukan."
      });
    }

    let localData = userWithHistory.historyDeposit[0];
    let localStatus = String(localData.status || "pending").toLowerCase();

    // ================= STATUS TERMINAL =================
    if (!["pending", "processing"].includes(localStatus)) {
      const breakdown = calculateDepositBreakdown({
        nominal: localData.nominal,
        kodeUnik: localData.kode_unik ?? localData.tambahan ?? 0,
        apiData: {
          fee: localData.fee_provider ?? 0,
          total_bayar: localData.total_amount ?? localData.total_bayar
        },
        role: user.role || req.session.role || "user"
      });
      const finalSaldoMasuk = Number(localData.get_balance) || breakdown.get_balance;

      return res.status(200).json({
        success: true,
        data: {
          id,
          trx_id: id,
          reff_id: localData.reff_id || localData.provider_reference_id || "-",
          nominal: breakdown.nominal,
          kode_unik: breakdown.kode_unik,
          tambahan: breakdown.tambahan,
          fee: Number(localData.fee) || breakdown.fee,
          fee_env: breakdown.fee_env,
          fee_app: breakdown.fee_app,
          fee_provider: breakdown.fee_provider,
          total_amount: breakdown.total_amount,
          total_bayar: breakdown.total_bayar,
          get_balance: finalSaldoMasuk,
          status: localStatus,
          metode: localData.metode || "QRIS",
          qr_image: localData.qr_image || null,
          bg_image: localData.bg_image || DITZNESIA_BG_IMAGE,
          qris_string: localData.qris_string || "",
          created_at: localData.created_at || null,
          expires_at: localData.provider_expires_at || null,
          paid_at: localData.provider_time || null,
          provider_id: localData.provider_id || null,
          provider_reference_id: localData.provider_reference_id || null,
          provider_amount: Number(localData.provider_amount) || breakdown.total_amount,
          provider_status: localData.provider_status || null,
          provider_time: localData.provider_time || null
        }
      });
    }

    const { apiKey } = getDitznesiaConfig();
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "API Key Ditznesia belum dikonfigurasi di server."
      });
    }

    let providerTrx = null;
    const targetPaymentId = localData.provider_id || id;

    // ================= CEK VIA GET /deposit/status (Ditznesia) =================
    if (targetPaymentId) {
      try {
        const { ok, json: detailData } = await fetchDitznesiaGet(
          "/deposit/status",
          { id: targetPaymentId },
          6000
        );
        if (ok && detailData) {
          providerTrx = extractDitznesiaPayload(detailData);
        }
      } catch (_) {}
    }

    // ================= PROSES STATUS PROVIDER =================
    if (providerTrx) {
      const providerStatus = normalizeDitznesiaStatus(
        providerTrx.status,
        localStatus
      );
      const pId = String(
        providerTrx.id || providerTrx.invoice_id || targetPaymentId
      );
      const pRef = String(providerTrx.trx_id || pId);
      const pPaidAt =
        parseIsoTimestamp(
          providerTrx.settlement_time ||
            providerTrx.paid_at ||
            providerTrx.updated_at ||
            providerTrx.created_at
        ) || null;
      const pExpiresAt =
        parseIsoTimestamp(
          providerTrx.expired_at ||
            providerTrx.expires_at ||
            providerTrx.expired_at_ms ||
            providerTrx.expires_at_ms
        ) || localData.provider_expires_at || null;

      if (providerStatus === "success") {
        const creditAmount = Number(localData.get_balance) || 0;

        const updateResult = await User.updateOne(
          {
            _id: user._id,
            historyDeposit: {
              $elemMatch: {
                id,
                status: { $in: ["pending", "processing"] }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status": "success",
              "historyDeposit.$.provider_id": pId,
              "historyDeposit.$.provider_reference_id": pRef,
              "historyDeposit.$.provider_amount":
                Number(
                  providerTrx.total_bayar ??
                    providerTrx.amount ??
                    localData.total_amount
                ) || 0,
              "historyDeposit.$.provider_status": "success",
              "historyDeposit.$.provider_time": pPaidAt,
              "historyDeposit.$.provider_expires_at": pExpiresAt
            },
            $inc: {
              saldo: creditAmount
            }
          }
        );

        if (updateResult.modifiedCount > 0) {
          localStatus = "success";
        }
      } else if (["failed", "expired", "cancelled"].includes(providerStatus)) {
        const updateResult = await User.updateOne(
          {
            _id: user._id,
            historyDeposit: {
              $elemMatch: {
                id,
                status: { $in: ["pending", "processing"] }
              }
            }
          },
          {
            $set: {
              "historyDeposit.$.status": providerStatus,
              "historyDeposit.$.provider_id": pId,
              "historyDeposit.$.provider_reference_id": pRef,
              "historyDeposit.$.provider_amount":
                Number(
                  providerTrx.total_bayar ??
                    providerTrx.amount ??
                    localData.total_amount
                ) || 0,
              "historyDeposit.$.provider_status": providerStatus,
              "historyDeposit.$.provider_time": pPaidAt,
              "historyDeposit.$.provider_expires_at": pExpiresAt
            }
          }
        );

        if (updateResult.modifiedCount > 0) {
          localStatus = providerStatus;
        }
      }
    }

    // ================= AMBIL DATA TERBARU =================
    const refreshedUser = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    localData = refreshedUser?.historyDeposit?.[0] || localData;
    localStatus = String(localData.status || localStatus || "pending").toLowerCase();

    const breakdown = calculateDepositBreakdown({
      nominal: localData.nominal,
      kodeUnik: localData.kode_unik ?? localData.tambahan ?? 0,
      apiData: {
        fee: localData.fee_provider ?? 0,
        total_bayar: localData.total_amount ?? localData.total_bayar
      },
      role: user.role || req.session.role || "user"
    });
    const finalSaldoMasuk = Number(localData.get_balance) || breakdown.get_balance;

    return res.status(200).json({
      success: true,
      data: {
        id,
        trx_id: id,
        reff_id: localData.reff_id || localData.provider_reference_id || "-",
        nominal: breakdown.nominal,
        kode_unik: breakdown.kode_unik,
        tambahan: breakdown.tambahan,
        fee: Number(localData.fee) || breakdown.fee,
        fee_env: breakdown.fee_env,
        fee_app: breakdown.fee_app,
        fee_provider: breakdown.fee_provider,
        total_amount: breakdown.total_amount,
        total_bayar: breakdown.total_bayar,
        get_balance: finalSaldoMasuk,
        status: localStatus,
        metode: localData.metode || "QRIS",
        qr_image: localData.qr_image || null,
        bg_image: localData.bg_image || DITZNESIA_BG_IMAGE,
        qris_string: localData.qris_string || "",
        created_at: localData.created_at || null,
        expires_at: localData.provider_expires_at || null,
        paid_at: localData.provider_time || null,
        provider_id: localData.provider_id || null,
        provider_reference_id: localData.provider_reference_id || null,
        provider_amount: Number(localData.provider_amount) || breakdown.total_amount,
        provider_status: localData.provider_status || null,
        provider_time: localData.provider_time || null
      }
    });
  } catch (error) {
    console.error("Error Status Check Ditznesia:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal memuat detail terbaru."
    });
  }
});

// ================= CANCEL DEPOSIT (DITZNESIA) =================
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      return res.status(401).json({ success: false, message: "Sesi tidak valid." });
    }

    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ success: false, message: "ID diperlukan." });
    }

    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({ success: false, message: "Data transaksi tidak ditemukan." });
    }

    const currentData = userHistory.historyDeposit[0];

    if (currentData.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Transaksi tidak bisa dibatalkan karena status sudah ${currentData.status}.`
      });
    }

    const { apiKey } = getDitznesiaConfig();
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "API Key Ditznesia belum dikonfigurasi di server."
      });
    }

    const targetPaymentId = currentData.provider_id || id;
    let result = null;

    try {
      const cancelRes = await fetchDitznesiaGet(
        "/deposit/cancel",
        { id: targetPaymentId },
        10000
      );
      result = cancelRes.json;
    } catch (fetchError) {
      console.error("Ditznesia Cancel Fetch Error:", fetchError);
      return res.status(502).json({
        success: false,
        message: "Koneksi server ke Ditznesia gagal saat membatalkan deposit."
      });
    }

    await editHistoryDeposit(user._id, id, "cancelled");

    return res.status(200).json({
      success: true,
      message: result?.message || "Deposit berhasil dibatalkan.",
      data: {
        id,
        trx_id: id,
        status: "cancelled"
      }
    });
  } catch (error) {
    console.error("Cancel Deposit Error:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan: " + error.message
    });
  }
});

// 1. Daftar game (pengganti /produk yang mengambil daftar provider)
router.get("/produk", requireLogin, async (req, res) => {
  const { search } = req.query;
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(400).json({
      success: false,
      message: "User tidak ditemukan.",
    });
  }

  try {
    const response = await axios.get(`${DITZ_BASE_URL}/tp-games`, {
      params: { apikey: DITZ_API_KEY },
    });

    const rawData = response.data?.data || response.data || [];
    const listGames = Array.isArray(rawData) ? rawData : [];

    const filtered = search
      ? listGames.filter((item) =>
          item.game?.toLowerCase().includes(search.toLowerCase())
        )
      : listGames;

    // Mapping field sesuai respons /tp-games: { game, products, need_zone }
    const formatted = filtered.map((item) => ({
      game: item.game,
      products: item.products,
      need_zone: Boolean(item.need_zone),
    }));

    return res.json({
      success: true,
      data: formatted,
    });
  } catch (error) {
    const errData = error.response?.data;
    return res.status(500).json({
      success: false,
      message: errData?.message || "Gagal memproses data game.",
      error: errData || error.message,
    });
  }
});

// 2. Nominal & harga per game (pengganti /produk-provider)
router.get("/produk-provider", requireLogin, async (req, res) => {
  const { provider, game } = req.query;
  const selectedGame = game || provider;

  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(400).json({
      success: false,
      message: "User tidak ditemukan.",
    });
  }

  try {
    const params = { apikey: DITZ_API_KEY };
    if (selectedGame) {
      params.game = selectedGame;
    }

    const response = await axios.get(`${DITZ_BASE_URL}/tp-products`, {
      params,
    });

    const rawData = response.data?.data || response.data || [];
    const products = Array.isArray(rawData) ? rawData : [];

    const filtered = selectedGame
      ? products.filter(
          (item) => item.game?.toLowerCase() === selectedGame.toLowerCase()
        )
      : products;

    return res.json({
      success: true,
      data: filtered,
    });
  } catch (error) {
    const errData = error.response?.data;
    return res.status(500).json({
      success: false,
      message: errData?.message || "Gagal memproses data produk game.",
      error: errData || error.message,
    });
  }
});

// 3. Buat order topup game (/tp-order) & pantau status (/tp-orders)
router.post("/order/create", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid.",
    });
  }

  const { code, tujuan: target, zone } = req.body;
  if (!code || !target) {
    return res.status(400).json({
      success: false,
      message: "Kode layanan dan tujuan harus diisi.",
    });
  }

  try {
    // Ambil daftar produk untuk validasi code, harga, dan need_zone
    const productsResponse = await axios.get(`${DITZ_BASE_URL}/tp-products`, {
      params: { apikey: DITZ_API_KEY },
    });

    const rawProducts = productsResponse.data?.data || productsResponse.data || [];
    const productList = Array.isArray(rawProducts) ? rawProducts : [];
    const product = productList.find(
      (item) => String(item.code) === String(code)
    );

    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Kode layanan tidak ditemukan atau tidak tersedia.",
      });
    }

    if (product.need_zone && !zone) {
      return res.status(400).json({
        success: false,
        message: "Game ini membutuhkan parameter zone.",
      });
    }

    let originalPrice = parseInt(product.price, 10) || 0;
    let modifiedPrice = originalPrice;
    if (user.role === "user") {
      modifiedPrice = originalPrice + 600;
    } else if (user.role === "reseller") {
      modifiedPrice = originalPrice + 260;
    }

    if (user.saldo < modifiedPrice) {
      return res.status(400).json({
        success: false,
        message: "Saldo Anda tidak mencukupi untuk melakukan transaksi ini.",
      });
    }

    const reff_id = generateReffId();

    // Sesuaikan nama field berikut dengan dokumentasi /tp-order di Ditznesia
    const orderResponse = await axios.get(`${DITZ_BASE_URL}/tp-order`, {
      params: {
        apikey: DITZ_API_KEY,
        code: code,
        target: target,
        ...(zone ? { zone } : {}),
        reff_id: reff_id,
      },
    });

    const createResult = orderResponse.data;
    const transactionDetails = createResult?.data || createResult;

    if (!transactionDetails || createResult?.status === false || createResult?.success === false) {
      return res.status(502).json({
        success: false,
        message: createResult?.message || "Gagal membuat transaksi ke provider.",
        error: transactionDetails || createResult,
      });
    }

    await User.findByIdAndUpdate(user._id, {
      $inc: { saldo: -modifiedPrice },
    });

    const txId = transactionDetails.id || transactionDetails.trx_id || reff_id;

    const historyDataForDb = {
      id: txId,
      reff_id: transactionDetails.reff_id || reff_id,
      layanan: transactionDetails.layanan || product.name,
      code: transactionDetails.code || code,
      target: zone ? `${target} (${zone})` : target,
      price: modifiedPrice.toString(),
      sn: transactionDetails.sn || null,
      status: transactionDetails.status || "pending",
      created_at: transactionDetails.created_at
        ? new Date(transactionDetails.created_at)
        : new Date(),
    };

    await tambahHistoryOrder(user._id, historyDataForDb);

    // Polling status menggunakan /tp-orders
    const maxPollingTime = 5 * 60 * 1000;
    const startTime = Date.now();
    const intervalId = setInterval(async () => {
      try {
        const statusResponse = await axios.get(`${DITZ_BASE_URL}/tp-orders`, {
          params: {
            apikey: DITZ_API_KEY,
            id: txId,
          },
        });

        const rawStatus = statusResponse.data?.data || statusResponse.data;
        const statusData = Array.isArray(rawStatus)
          ? rawStatus.find((item) => String(item.id) === String(txId)) || rawStatus[0]
          : rawStatus;

        if (statusData && statusData.status) {
          const currentTxStatus = String(statusData.status).toLowerCase();
          const currentSn = statusData.sn || null;

          await editHistoryOrder(user._id, txId, {
            status: currentTxStatus,
            sn: currentSn,
          });

          if (["success", "sukses"].includes(currentTxStatus)) {
            clearInterval(intervalId);
          }

          if (["failed", "gagal", "cancel", "batal"].includes(currentTxStatus)) {
            const orderInDb = await User.findOne(
              {
                _id: user._id,
                "historyOrder.id": txId,
                "historyOrder.status": { $ne: "failed_refunded" },
              },
              { "historyOrder.$": 1 }
            );

            if (
              orderInDb &&
              orderInDb.historyOrder.length > 0 &&
              orderInDb.historyOrder[0].status !== "failed_refunded"
            ) {
              await User.updateOne(
                { _id: user._id, "historyOrder.id": txId },
                {
                  $inc: { saldo: modifiedPrice },
                  $set: { "historyOrder.$.status": "failed_refunded" },
                }
              );
            }
            clearInterval(intervalId);
          }

          if (
            ["success", "sukses", "failed", "gagal", "cancel", "batal"].includes(currentTxStatus) ||
            Date.now() - startTime > maxPollingTime
          ) {
            clearInterval(intervalId);
          }
        }
      } catch (pollError) {
        console.error(pollError?.response?.data || pollError.message);
      }
    }, 1000);

    return res.status(200).json({
      success: true,
      data: {
        ...transactionDetails,
        id: txId,
        price: modifiedPrice.toString(),
      },
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memproses order.",
      error: apiError || error.message,
    });
  }
});


router.post("/order/check", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }
  const {
    id
  } = req.body;
  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID order harus diisi.",
    });
  }
  try {
    const userWithOrder = await User.findOne({
      _id: user._id,
      "historyOrder.id": id
    }, {
      "historyOrder.$": 1
    });
    if (!userWithOrder || !userWithOrder.historyOrder.length) {
      return res.status(404).json({
        success: false,
        message: "Order Tidak Ditemukan Di Mutasi Anda.",
      });
    }
    const formDataToAtlanticStatus = {
      api_key: process.env.ATLAN_API_KEY,
      id: id,
      type: "prabayar",
    };
    const statusResponse = await cloudscraper.post(`${BASE_URL}/transaksi/status`, {
      body: qs.stringify(formDataToAtlanticStatus),
      headers: cloudscraperHeaders,
    });
    const statusResult = JSON.parse(statusResponse);
    if (!statusResult || !statusResult.status || !statusResult.data) {
      return res.status(502).json({
        success: false,
        message: statusResult?.message || "Gagal memeriksa status order dari provider.",
        error: statusResult?.data || statusResult,
      });
    }
    const orderDetails = statusResult.data;
    return res.status(200).json({
      status: true,
      data: {
        id: orderDetails.id,
        reff_id: orderDetails.reff_id,
        layanan: orderDetails.layanan,
        code: orderDetails.code,
        target: orderDetails.target,
        price: orderDetails.price,
        sn: orderDetails.sn || null,
        status: orderDetails.status,
        created_at: orderDetails.created_at,
      },
      code: 200,
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memeriksa status order.",
      error: apiError || error.message,
    });
  }
});

module.exports = router;
