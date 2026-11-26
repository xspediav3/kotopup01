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

// ================= BUAT TRANSAKSI DEPOSIT (DITZNESIA) =================
router.post("/deposit/create", requireLogin, async (req, res) => {
  console.log("🔔 [DEPOSIT] Endpoint /deposit/create dipanggil");
  const user = await User.findById(req.session.userId);
  if (!user) {
    console.log("🚫 User tidak ditemukan atau sesi tidak valid. ID Session:", req.session.userId);
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }

  const { nominal, metode: metodePilihanPengguna } = req.body;
  console.log(`📥 Permintaan deposit oleh ${user.username || user.email || user._id}`);
  console.log("🧾 Data diterima:", { nominal, metode: metodePilihanPengguna });

  if (!nominal || isNaN(nominal)) {
    console.log("❗ Nominal tidak valid:", nominal);
    return res.status(400).json({
      success: false,
      message: "Nominal harus diisi dan berupa angka."
    });
  }

  const parsedNominal = parseInt(nominal, 10);
  let selectedMetodeCode = "QRISFAST";
  let minDepositForMetode = 1000;

  if (metodePilihanPengguna) {
    const normalizedInput = String(metodePilihanPengguna).toUpperCase();
    const supportedQris = ["QRIS", "QRISFAST", "QRISPAST"];
    if (!supportedQris.includes(normalizedInput)) {
      return res.status(400).json({
        success: false,
        message: `Metode pembayaran '${metodePilihanPengguna}' tidak ditemukan atau tidak aktif.`
      });
    }
    selectedMetodeCode = normalizedInput === "QRIS" ? "QRISFAST" : normalizedInput;
    minDepositForMetode = 1000;
  }

  if (parsedNominal < minDepositForMetode) {
    return res.status(400).json({
      success: false,
      message: `Nominal minimal untuk metode ${selectedMetodeCode} adalah ${minDepositForMetode}. Nominal Anda: ${parsedNominal}.`
    });
  }

  const { apiKey } = getDitznesiaConfig();
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      message: "API Key Ditznesia belum dikonfigurasi di server."
    });
  }

  const kodeUnik = Math.floor(Math.random() * 250) + 1;
  const totalBayarRequest = parsedNominal + kodeUnik;
  const reff_id = generateReffId();

  try {
    const { ok, json: resultFromDitznesia } = await fetchDitznesiaGet("/deposit/create", {
      nominal: totalBayarRequest
    });

    const depositDetails = extractDitznesiaPayload(resultFromDitznesia);
    const isApiSuccess =
      ok &&
      resultFromDitznesia?.success !== false &&
      resultFromDitznesia?.status !== false &&
      Boolean(depositDetails?.id || depositDetails?.invoice_id || depositDetails?.trx_id);

    if (!isApiSuccess) {
      return res.status(502).json({
        success: false,
        message:
          resultFromDitznesia?.message ||
          resultFromDitznesia?.error ||
          depositDetails?.message ||
          "Gagal membuat permintaan deposit ke provider.",
        error: resultFromDitznesia
      });
    }

    const trxId = String(
      depositDetails.id || depositDetails.invoice_id || depositDetails.trx_id
    );
    const providerReffId = String(depositDetails.trx_id || depositDetails.reff_id || reff_id);
    const initialStatus = normalizeDitznesiaStatus(depositDetails.status, "pending");

    const apiTotalBayar =
      parseInt(depositDetails.total_bayar ?? depositDetails.total_payment ?? totalBayarRequest, 10) ||
      totalBayarRequest;
    const rawGetBalance =
      parseInt(depositDetails.total_diterima ?? depositDetails.get_balance ?? parsedNominal, 10) ||
      parsedNominal;
    const providerFee = parseInt(depositDetails.fee ?? 0, 10) || 0;

    const { totalFee, finalBalance } = calculateUserFeeAndBalance(
      rawGetBalance,
      user.role,
      providerFee
    );

    const qrImage =
      depositDetails.qr_link ||
      depositDetails.qr_image ||
      depositDetails.qris_url ||
      depositDetails.url ||
      null;
    const qrisString =
      depositDetails.qr_string ||
      depositDetails.qris_string ||
      depositDetails.qr_code ||
      depositDetails.pay_url ||
      "";
    const expiresAt =
      parseIsoTimestamp(
        depositDetails.expired_at ||
          depositDetails.expires_at ||
          depositDetails.expired_at_ms ||
          depositDetails.expires_at_ms
      ) || null;

    const historyDataForDb = {
      id: trxId,
      reff_id: providerReffId,
      nominal: parsedNominal,
      tambahan: kodeUnik,
      fee: totalFee,
      get_balance: finalBalance,
      total_bayar: apiTotalBayar,
      metode: selectedMetodeCode,
      bank: depositDetails.bank || null,
      tujuan: depositDetails.tujuan || depositDetails.nomor_va || null,
      atas_nama: depositDetails.atas_nama || null,
      status: initialStatus,
      qr_image: qrImage,
      qris_string: qrisString,
      bg_image: DITZNESIA_BG_IMAGE,
      expires_at: expiresAt,
      created_at: parseIsoTimestamp(depositDetails.created_at)
        ? new Date(parseIsoTimestamp(depositDetails.created_at))
        : new Date()
    };

    await tambahHistoryDeposit(user._id, historyDataForDb);

    res.status(200).json({
      success: true,
      data: {
        ...depositDetails,
        id: trxId,
        trx_id: trxId,
        reff_id: providerReffId,
        nominal: parsedNominal,
        tambahan: kodeUnik,
        fee: totalFee,
        get_balance: finalBalance,
        total_bayar: apiTotalBayar,
        total_amount: apiTotalBayar,
        metode: selectedMetodeCode,
        status: initialStatus,
        qr_image: qrImage,
        qris_string: qrisString,
        bg_image: DITZNESIA_BG_IMAGE,
        expires_at: expiresAt
      }
    });

    // ================= BACKGROUND POLLING DITZNESIA (TIAP 3 DETIK) =================
    const POLL_INTERVAL_MS = 3000;
    const MAX_POLL_DURATION_MS = 15 * 60 * 1000 + 30000;

    const intervalId = setInterval(async () => {
      try {
        const userToCheck = await User.findOne(
          { _id: user._id, "historyDeposit.id": trxId },
          { "historyDeposit.$": 1, saldo: 1 }
        );

        const txInDb = userToCheck?.historyDeposit?.[0];
        if (!txInDb) {
          clearInterval(intervalId);
          return;
        }

        const dbStatusNormalized = normalizeDitznesiaStatus(txInDb.status, "pending");
        if (["success", "failed", "expired", "cancel"].includes(dbStatusNormalized)) {
          clearInterval(intervalId);
          return;
        }

        const { ok: checkOk, json: statusUpdateData } = await fetchDitznesiaGet(
          "/deposit/status",
          { id: trxId },
          8000
        );

        if (!checkOk || !statusUpdateData) return;

        const latestPayload = extractDitznesiaPayload(statusUpdateData);
        const currentTxStatus = normalizeDitznesiaStatus(latestPayload?.status, "");
        if (!currentTxStatus) return;

        if (currentTxStatus !== txInDb.status) {
          await editHistoryDeposit(user._id, trxId, currentTxStatus);
        }

        if (currentTxStatus === "success" && dbStatusNormalized !== "success") {
          const creditAmount = parseInt(txInDb.get_balance, 10) || finalBalance;
          const credited = await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: trxId,
                  status: { $ne: "success" }
                }
              }
            },
            {
              $set: { "historyDeposit.$.status": "success" },
              $inc: { saldo: creditAmount }
            }
          );

          if (credited.modifiedCount > 0) {
            console.log(`✅ [DEPOSIT] Ditznesia SUCCESS +${creditAmount} untuk user ${user._id} (ID: ${trxId})`);
          }
        }

        if (["success", "failed", "expired", "cancel"].includes(currentTxStatus)) {
          clearInterval(intervalId);
        }
      } catch (pollError) {
        console.error(`Gagal cek status deposit Ditznesia (ID: ${trxId}):`, pollError?.message || pollError);
      }
    }, POLL_INTERVAL_MS);

    setTimeout(() => clearInterval(intervalId), MAX_POLL_DURATION_MS);
  } catch (error) {
    console.error("❌ [DEPOSIT CREATE] Error:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Terjadi kesalahan internal saat memproses deposit.",
        error: error.message
      });
    }
  }
});

// ================= CEK STATUS DEPOSIT (DITZNESIA) =================
router.post("/deposit/status", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID deposit harus diisi."
    });
  }

  const { apiKey } = getDitznesiaConfig();
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      message: "API Key Ditznesia belum dikonfigurasi di server."
    });
  }

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || userHistory.historyDeposit.length === 0) {
      return res.status(404).json({
        success: false,
        message: "ID deposit tidak ditemukan dalam riwayat Anda."
      });
    }

    const txInDb = userHistory.historyDeposit[0];
    const { ok, json: resultFromDitznesia } = await fetchDitznesiaGet(
      "/deposit/status",
      { id },
      8000
    );

    const depositDetails = extractDitznesiaPayload(resultFromDitznesia);
    const isApiSuccess =
      ok &&
      resultFromDitznesia?.success !== false &&
      resultFromDitznesia?.status !== false &&
      Boolean(depositDetails?.status || depositDetails?.id || depositDetails?.invoice_id);

    if (!isApiSuccess) {
      return res.status(502).json({
        success: false,
        message:
          resultFromDitznesia?.message ||
          resultFromDitznesia?.error ||
          "Gagal memeriksa status deposit ke provider.",
        error: resultFromDitznesia
      });
    }

    const normalizedStatus = normalizeDitznesiaStatus(
      depositDetails.status,
      txInDb.status || "pending"
    );
    const dbStatusNormalized = normalizeDitznesiaStatus(txInDb.status, "pending");

    if (normalizedStatus !== txInDb.status) {
      await editHistoryDeposit(user._id, id, normalizedStatus);
    }

    const baseAmount =
      parseInt(
        depositDetails.total_diterima ??
          depositDetails.get_balance ??
          txInDb.nominal ??
          0,
        10
      ) || 0;
    const providerFee = parseInt(depositDetails.fee ?? 0, 10) || 0;
    const { totalFee, finalBalance } = calculateUserFeeAndBalance(
      baseAmount,
      user.role,
      providerFee
    );
    const creditAmount = parseInt(txInDb.get_balance, 10) || finalBalance;

    if (normalizedStatus === "success" && dbStatusNormalized !== "success") {
      await User.updateOne(
        {
          _id: user._id,
          historyDeposit: {
            $elemMatch: {
              id,
              status: { $ne: "success" }
            }
          }
        },
        {
          $set: { "historyDeposit.$.status": "success" },
          $inc: { saldo: creditAmount }
        }
      );
    }

    const nominal = parseInt(txInDb.nominal ?? depositDetails.nominal ?? 0, 10) || 0;
    const tambahan = parseInt(txInDb.tambahan ?? depositDetails.tambahan ?? 0, 10) || 0;
    const totalBayar =
      parseInt(txInDb.total_bayar ?? depositDetails.total_bayar ?? nominal + tambahan, 10) ||
      nominal + tambahan;

    return res.status(200).json({
      success: true,
      data: {
        id: String(depositDetails.id || depositDetails.invoice_id || id),
        trx_id: String(depositDetails.id || depositDetails.invoice_id || id),
        reff_id: String(depositDetails.trx_id || depositDetails.reff_id || txInDb.reff_id || "-"),
        nominal,
        tambahan,
        fee: txInDb.fee ?? totalFee,
        get_balance: creditAmount,
        total_bayar: totalBayar,
        total_amount: totalBayar,
        metode: txInDb.metode || depositDetails.metode || "QRISFAST",
        qr_image: txInDb.qr_image || depositDetails.qr_link || depositDetails.qr_image || null,
        qris_string: txInDb.qris_string || depositDetails.qr_string || "",
        bg_image: txInDb.bg_image || DITZNESIA_BG_IMAGE,
        status: normalizedStatus,
        expires_at: txInDb.expires_at || parseIsoTimestamp(depositDetails.expired_at || depositDetails.expires_at) || null,
        created_at: depositDetails.created_at || txInDb.created_at
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan internal saat memeriksa status deposit.",
      error: error.message
    });
  }
});

// ================= CANCEL DEPOSIT (DITZNESIA) =================
router.post("/deposit/cancel", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid."
    });
  }

  const { id } = req.body;
  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID deposit harus diisi."
    });
  }

  const { apiKey } = getDitznesiaConfig();
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      message: "API Key Ditznesia belum dikonfigurasi di server."
    });
  }

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    if (!userHistory || userHistory.historyDeposit.length === 0) {
      return res.status(404).json({
        success: false,
        message: "ID deposit tidak ditemukan dalam riwayat Anda."
      });
    }

    const txInDb = userHistory.historyDeposit[0];
    const { ok, json: resultFromDitznesia } = await fetchDitznesiaGet(
      "/deposit/cancel",
      { id },
      8000
    );

    const cancelDetails = extractDitznesiaPayload(resultFromDitznesia);
    const isApiSuccess =
      ok &&
      resultFromDitznesia?.success !== false &&
      resultFromDitznesia?.status !== false;

    if (!isApiSuccess) {
      return res.status(502).json({
        success: false,
        message:
          resultFromDitznesia?.message ||
          resultFromDitznesia?.error ||
          cancelDetails?.message ||
          "Gagal membatalkan deposit ke provider.",
        error: resultFromDitznesia
      });
    }

    const finalCancelStatus = normalizeDitznesiaStatus(cancelDetails?.status, "cancel");
    await editHistoryDeposit(user._id, id, finalCancelStatus);

    return res.status(200).json({
      success: true,
      data: {
        id: String(cancelDetails?.id || id),
        status: finalCancelStatus,
        created_at: cancelDetails?.created_at || txInDb.created_at
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan internal saat membatalkan deposit.",
      error: error.message
    });
  }
});

const axios = require("axios"); // atau gunakan fetch / cloudscraper sesuai kebutuhan

const DITZ_BASE_URL = "https://www.ditznesia.com/api/dev";
const DITZ_API_KEY = process.env.DITZ_API_KEY || "6985b717a060a0906af01d335034b40f";

// 0. Daftar harga layanan / produk topup (disesuaikan ke Ditznesia /tp-products)

const normText = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

router.post("/layanan/price-list", requireLogin, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User tidak ditemukan atau sesi tidak valid.",
      });
    }

    const { code, game, provider } = req.body || {};
    const selectedGame = String(game || provider || "").trim();

    const params = { apikey: DITZ_API_KEY };
    if (selectedGame) params.game = selectedGame;

    const response = await axios.get(`${DITZ_BASE_URL}/tp-products`, {
      params,
      timeout: 15000,
    });

    const rawData = response.data?.data || response.data || [];
    let products = Array.isArray(rawData) ? rawData : [];

    if (selectedGame) {
      const target = normText(selectedGame);

      // Cocokkan exact dulu (abaikan spasi/huruf besar), lalu parsial
      const exact = products.filter((item) => normText(item.game) === target);
      products = exact.length
        ? exact
        : products.filter((item) => {
            const g = normText(item.game);
            return g && (g.includes(target) || target.includes(g));
          });
    }

    if (code) {
      products = products.filter((item) => String(item.code) === String(code));
    }

    const modifiedData = products.map((item) => {
      const originalPrice = parseInt(item.price, 10) || 0;
      let modifiedPrice = originalPrice;
      if (user.role === "user") {
        modifiedPrice = originalPrice + 600;
      } else if (user.role === "reseller") {
        modifiedPrice = originalPrice + 260;
      }

      return {
        code: item.code,
        name: item.name,
        category: item.game || item.category || null,
        type: item.type || "topup_game",
        provider: item.game || item.provider || null,
        price: modifiedPrice.toString(),
        price_original: item.price_original ?? null,
        flash: item.flash ?? null,
        need_zone: Boolean(item.need_zone),
        check_name: Boolean(item.check_name),
        note: item.note || null,
        status: item.status || "available",
        img_url: item.img_url || null,
      };
    });

    return res.status(200).json({
      success: true,
      data: modifiedData,
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message:
        apiError?.message ||
        "Terjadi kesalahan internal saat memproses permintaan.",
      error: apiError || error.message,
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
