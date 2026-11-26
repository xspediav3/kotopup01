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

// ================= HELPER DITZNESIA DEPOSIT =================
const DITZ_DEPOSIT_BG_URL = "https://files.catbox.moe/mbhgwo.png";

function resolveDitzApiKey() {
  return (
    process.env.DITZ_API_KEY ||
    process.env.DITZNESIA_API_KEY ||
    "6985b717a060a0906af01d335034b40f"
  );
}

function resolveDitzBaseUrl() {
  return (
    process.env.DITZ_BASE_URL ||
    process.env.DITZNESIA_BASE_URL ||
    "https://www.ditznesia.com/api/dev"
  ).replace(/\/+$/, "");
}

function extractDitzDepositData(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)) {
    return raw.data;
  }
  if (raw.deposit && typeof raw.deposit === "object") {
    return raw.deposit;
  }
  return raw;
}

function normalizeDepositStatus(rawStatus, fallback = "pending") {
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

function parseDepositDate(val) {
  if (!val) return null;
  if (typeof val === "number") {
    const ms = val < 1e12 ? val * 1000 : val;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(String(val));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function calcDepositAdminAndBalance({ nominal, kodeUnik = 0, apiData = {}, role = "user" }) {
  const cleanNominal = Math.max(0, parseInt(nominal, 10) || 0);
  const cleanKodeUnik = Math.max(0, parseInt(kodeUnik, 10) || 0);

  // Admin / fee yang dikembalikan oleh API Ditznesia
  const apiFee = Math.max(
    0,
    parseInt(apiData.fee ?? apiData.fee_amount ?? apiData.biaya_admin ?? 0, 10) || 0
  );

  // Admin tambahan dari sistem/kode berdasarkan role
  let appFee = 0;
  if (role === "user") {
    appFee = Math.ceil(cleanNominal * 0.002); // 0.2% (1000 -> 3)
  } else if (role === "reseller") {
    appFee = Math.ceil(cleanNominal * 0.001); // 0.1%
  }

  // Total biaya admin (gabungan admin API + admin kode)
  const totalFee = apiFee + appFee;

  // Total yang harus dibayar user
  const rawApiTotalBayar = parseInt(
    apiData.total_bayar ?? apiData.total_payment ?? 0,
    10
  );
  const totalBayar =
    rawApiTotalBayar > 0
      ? rawApiTotalBayar
      : cleanNominal + cleanKodeUnik + apiFee;

  // Saldo diterima user (dipotong admin kode agar tidak melebihi nominal input)
  const finalBalance = Math.max(0, cleanNominal - appFee);

  return {
    nominal: cleanNominal,
    tambahan: cleanKodeUnik,
    kode_unik: cleanKodeUnik,
    fee_provider: apiFee,
    fee_app: appFee,
    fee: totalFee,
    total_bayar: totalBayar,
    total_amount: totalBayar,
    get_balance: finalBalance
  };
}


const axios = require("axios");

// ================= HELPER PERHITUNGAN ADMIN DEPOSIT =================
function getRoleFeePercent(role = "user") {
  const normalizedRole = String(role || "user").toLowerCase();
  if (normalizedRole === "user") return 1.5;
  if (normalizedRole === "reseller") return 0.7;
  return 0;
}

function calcDepositAdminAndBalance({ nominal = 0, kodeUnik = 0, apiData = {}, role = "user" }) {
  const cleanNominal = Math.max(parseInt(nominal, 10) || 0, 0);
  const cleanKodeUnik = Math.max(parseInt(kodeUnik, 10) || 0, 0);

  const feePersen = getRoleFeePercent(role);
  const feeApp = Math.round((cleanNominal * feePersen) / 100);
  const feeProvider = Math.max(parseInt(apiData?.fee ?? 0, 10) || 0, 0);

  // Total biaya admin yang tampil ke user
  const totalFee = feeApp + feeProvider;

  // Saldo diterima tetap sebesar nominal deposit murni
  const getBalance = cleanNominal;

  // Total bayar di UI: nominal + biaya admin (totalFee)
  // Sementara total_bayar_provider menyimpan nominal + kodeUnik (atau total_bayar dari API)
  const totalBayarProvider =
    parseInt(apiData?.total_bayar, 10) || cleanNominal + cleanKodeUnik;
  const totalAmount = cleanNominal + totalFee;

  return {
    nominal: cleanNominal,
    tambahan: cleanKodeUnik,
    kode_unik: cleanKodeUnik,
    fee_persen: feePersen,
    fee_app: feeApp,
    fee_provider: feeProvider,
    fee: totalFee,
    get_balance: getBalance,
    total_bayar: totalBayarProvider,
    total_amount: totalAmount
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
    const tambahanPersen = getRoleFeePercent(role);

    // Default metode QRIS Ditznesia (tetap kompatibel dengan format frontend sebelumnya)
    let rawMethods = [
      {
        metode: "QRISFAST",
        type: "ewallet",
        name: "QRIS Otomatis (All Payment)",
        min: 1000,
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

  const apiKey = resolveDitzApiKey();
  const baseUrl = resolveDitzBaseUrl();

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
    const ditzResponse = await axios.get(`${baseUrl}/deposit/create`, {
      params: {
        apikey: apiKey,
        nominal: totalBayarRequest
      },
      timeout: 15000
    });

    const resultFromDitz = ditzResponse.data || {};
    const depositDetails = extractDitzDepositData(resultFromDitz);

    const isApiSuccess =
      resultFromDitz.success !== false &&
      resultFromDitz.status !== false &&
      Boolean(depositDetails?.id || depositDetails?.invoice_id || depositDetails?.trx_id);

    if (!isApiSuccess) {
      return res.status(502).json({
        success: false,
        message:
          resultFromDitz?.message ||
          resultFromDitz?.error ||
          depositDetails?.message ||
          "Gagal membuat permintaan deposit ke provider.",
        error: resultFromDitz
      });
    }

    const trxId = String(
      depositDetails.id || depositDetails.invoice_id || depositDetails.trx_id
    );
    const providerReffId = String(depositDetails.trx_id || depositDetails.reff_id || reff_id);
    const initialStatus = normalizeDepositStatus(depositDetails.status, "pending");

    const calc = calcDepositAdminAndBalance({
      nominal: parsedNominal,
      kodeUnik,
      apiData: depositDetails,
      role: user.role || req.session.role || "user"
    });

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
      parseDepositDate(
        depositDetails.expired_at ||
          depositDetails.expires_at ||
          depositDetails.expired_at_ms ||
          depositDetails.expires_at_ms
      ) || null;

    const historyDataForDb = {
      id: trxId,
      reff_id: providerReffId,
      nominal: calc.nominal,
      tambahan: calc.tambahan,
      kode_unik: calc.kode_unik,
      fee: calc.fee,
      fee_provider: calc.fee_provider,
      fee_app: calc.fee_app,
      get_balance: calc.get_balance,
      total_bayar: calc.total_bayar,
      total_amount: calc.total_amount,
      metode: selectedMetodeCode,
      bank: depositDetails.bank || null,
      tujuan: depositDetails.tujuan || depositDetails.nomor_va || null,
      atas_nama: depositDetails.atas_nama || null,
      status: initialStatus,
      qr_image: qrImage,
      qris_string: qrisString,
      bg_image: DITZ_DEPOSIT_BG_URL,
      expires_at: expiresAt,
      created_at: parseDepositDate(depositDetails.created_at)
        ? new Date(parseDepositDate(depositDetails.created_at))
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
        nominal: calc.nominal,
        tambahan: calc.tambahan,
        kode_unik: calc.kode_unik,
        fee: calc.fee,
        fee_provider: calc.fee_provider,
        fee_app: calc.fee_app,
        get_balance: calc.get_balance,
        total_bayar: calc.total_bayar,
        total_amount: calc.total_amount,
        metode: selectedMetodeCode,
        status: initialStatus,
        qr_image: qrImage,
        qris_string: qrisString,
        bg_image: DITZ_DEPOSIT_BG_URL,
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

        const dbStatusNormalized = normalizeDepositStatus(txInDb.status, "pending");
        if (["success", "failed", "expired", "cancel"].includes(dbStatusNormalized)) {
          clearInterval(intervalId);
          return;
        }

        const checkStatusResponse = await axios.get(`${baseUrl}/deposit/status`, {
          params: {
            apikey: apiKey,
            id: trxId
          },
          timeout: 10000
        });

        const statusUpdateData = checkStatusResponse.data || {};
        const latestPayload = extractDitzDepositData(statusUpdateData);
        const currentTxStatus = normalizeDepositStatus(latestPayload?.status, "");

        if (!currentTxStatus) return;

        if (currentTxStatus !== txInDb.status) {
          await editHistoryDeposit(user._id, trxId, currentTxStatus);
        }

        if (currentTxStatus === "success" && dbStatusNormalized !== "success") {
          const creditAmount = parseInt(txInDb.get_balance, 10) || calc.get_balance;
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
        console.error(`Gagal cek status deposit Ditznesia (ID: ${trxId}):`, pollError?.response?.data || pollError.message);
      }
    }, POLL_INTERVAL_MS);

    setTimeout(() => clearInterval(intervalId), MAX_POLL_DURATION_MS);
  } catch (error) {
    const apiError = error.response?.data;
    console.error("❌ [DEPOSIT CREATE] Error:", apiError || error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: apiError?.message || "Terjadi kesalahan internal saat memproses deposit.",
        error: apiError || error.message
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

  const apiKey = resolveDitzApiKey();
  const baseUrl = resolveDitzBaseUrl();

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
    const response = await axios.get(`${baseUrl}/deposit/status`, {
      params: {
        apikey: apiKey,
        id
      },
      timeout: 15000
    });

    const resultFromDitz = response.data || {};
    const depositDetails = extractDitzDepositData(resultFromDitz);

    const isApiSuccess =
      resultFromDitz.success !== false &&
      resultFromDitz.status !== false &&
      Boolean(depositDetails?.status || depositDetails?.id || depositDetails?.invoice_id);

    if (!isApiSuccess) {
      return res.status(502).json({
        success: false,
        message:
          resultFromDitz?.message ||
          resultFromDitz?.error ||
          "Gagal memeriksa status deposit ke provider.",
        error: resultFromDitz
      });
    }

    const normalizedStatus = normalizeDepositStatus(
      depositDetails.status,
      txInDb.status || "pending"
    );
    const dbStatusNormalized = normalizeDepositStatus(txInDb.status, "pending");

    if (normalizedStatus !== txInDb.status) {
      await editHistoryDeposit(user._id, id, normalizedStatus);
    }

    const calc = calcDepositAdminAndBalance({
      nominal: txInDb.nominal ?? depositDetails.nominal ?? 0,
      kodeUnik: txInDb.tambahan ?? txInDb.kode_unik ?? depositDetails.tambahan ?? 0,
      apiData: {
        fee: depositDetails.fee ?? txInDb.fee_provider ?? 0,
        total_bayar: txInDb.total_bayar ?? depositDetails.total_bayar
      },
      role: user.role || req.session.role || "user"
    });

    const fee = txInDb.fee ?? calc.fee;
    const totalAmount = txInDb.total_amount ?? (calc.nominal + fee);
    const creditAmount = parseInt(txInDb.get_balance, 10) || calc.get_balance;

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

    return res.status(200).json({
      success: true,
      data: {
        id: String(depositDetails.id || depositDetails.invoice_id || id),
        trx_id: String(depositDetails.id || depositDetails.invoice_id || id),
        reff_id: String(depositDetails.trx_id || depositDetails.reff_id || txInDb.reff_id || "-"),
        nominal: calc.nominal,
        tambahan: calc.tambahan,
        kode_unik: calc.kode_unik,
        fee,
        fee_provider: txInDb.fee_provider ?? calc.fee_provider,
        fee_app: txInDb.fee_app ?? calc.fee_app,
        get_balance: creditAmount,
        total_bayar: calc.total_bayar,
        total_amount: totalAmount,
        metode: txInDb.metode || depositDetails.metode || "QRISFAST",
        qr_image: txInDb.qr_image || depositDetails.qr_link || depositDetails.qr_image || null,
        qris_string: txInDb.qris_string || depositDetails.qr_string || "",
        bg_image: txInDb.bg_image || DITZ_DEPOSIT_BG_URL,
        status: normalizedStatus,
        expires_at:
          txInDb.expires_at ||
          parseDepositDate(depositDetails.expired_at || depositDetails.expires_at) ||
          null,
        created_at: depositDetails.created_at || txInDb.created_at
      }
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat memeriksa status deposit.",
      error: apiError || error.message
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

  const apiKey = resolveDitzApiKey();
  const baseUrl = resolveDitzBaseUrl();

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
    const response = await axios.get(`${baseUrl}/deposit/cancel`, {
      params: {
        apikey: apiKey,
        id
      },
      timeout: 15000
    });

    const resultFromDitz = response.data || {};
    const cancelDetails = extractDitzDepositData(resultFromDitz);

    const isApiSuccess =
      resultFromDitz.success !== false &&
      resultFromDitz.status !== false;

    if (!isApiSuccess) {
      return res.status(502).json({
        success: false,
        message:
          resultFromDitz?.message ||
          resultFromDitz?.error ||
          cancelDetails?.message ||
          "Gagal membatalkan deposit ke provider.",
        error: resultFromDitz
      });
    }

    const finalCancelStatus = normalizeDepositStatus(cancelDetails?.status, "cancel");
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
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message: apiError?.message || "Terjadi kesalahan internal saat membatalkan deposit.",
      error: apiError || error.message
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
