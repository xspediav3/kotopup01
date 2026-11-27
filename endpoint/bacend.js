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
  sendOrderSuccessEmail,
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

// ================= DAFTAR METODE DEPOSIT =================
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    let feePersen =
      role === "reseller"
        ? (process.env.FEE_PERCENT_RESELLER || "0.7")
        : (process.env.FEE_PERCENT_USER || "1.5");

    const metodeFormatted = [
      {
        metode: "qris",
        type: "ewallet",
        name: "QRIS All Payment (Otomatis)",
        min: 1000,
        max: 5000000,
        fee: 0,
        fee_persen: feePersen,
        status: "aktif",
        img_url: `${fullUrl}/media/metode/qrisfast.png`,
      },
    ];

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit Ditznesia",
      metode: metodeFormatted,
    });
  } catch (error) {
    console.error("Error deposit/metode:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil metode.",
    });
  }
});
// ================= DAFTAR METODE DEPOSIT =================
router.post("/deposit/metode", requireLogin, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.session.role || "user";

    let feePersen =
      role === "reseller"
        ? (process.env.FEE_PERCENT_RESELLER || "0.7")
        : (process.env.FEE_PERCENT_USER || "1.5");

    const metodeFormatted = [
      {
        metode: "qris",
        type: "ewallet",
        name: "QRIS All Payment (Otomatis)",
        min: 1000,
        max: 5000000,
        fee: 0,
        fee_persen: feePersen,
        status: "aktif",
        img_url: `${fullUrl}/media/metode/qrisfast.png`,
      },
    ];

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit Ditznesia",
      metode: metodeFormatted,
    });
  } catch (error) {
    console.error("Error deposit/metode:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil metode.",
    });
  }
});

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

    if (!nominal || !Number.isFinite(parsedNominal) || parsedNominal < 1000) {
      return res.status(400).json({
        success: false,
        message: "Minimal deposit Rp1.000"
      });
    }

    const DITZ_BASE = process.env.DITZ_BASE_URL || "https://www.ditznesia.com/api/dev";
    const DITZ_API_KEY = process.env.DITZ_API_KEY || "6985b717a060a0906af01d335034b40f";

    if (!DITZ_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API Key Ditznesia belum dikonfigurasi di server."
      });
    }

    // Kode unik: 100-400 untuk 1k, kelipatan per 10k (10k = 1x, 20k = 2x, dst.)
    const baseUnik = Math.floor(Math.random() * (400 - 100 + 1)) + 100;
    const kelipatan10k = parsedNominal >= 10000 ? Math.max(1, Math.floor(parsedNominal / 10000)) : 1;
    const kodeUnik = parsedNominal >= 10000 ? baseUnik * kelipatan10k : baseUnik;

    const totalBayarRequest = parsedNominal + kodeUnik;
    const saldoDiterima = parsedNominal;

    const createUrl = `${DITZ_BASE}/deposit/create?apikey=${encodeURIComponent(DITZ_API_KEY)}&nominal=${totalBayarRequest}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(createUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        signal: controller.signal
      });
    } catch (fetchError) {
      console.error("Ditznesia Create Fetch Error:", fetchError?.message || fetchError);
      return res.status(502).json({
        success: false,
        message: "Koneksi server ke Ditznesia gagal."
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch (jsonError) {
      console.error("Ditznesia Create Invalid Response (Bukan JSON):", responseText.slice(0, 500));
      return res.status(502).json({
        success: false,
        message: "Server Ditznesia mengembalikan respons yang bukan JSON."
      });
    }

    const paymentData = result?.data || result?.deposit || result;
    const isSuccess =
      response.ok &&
      result?.success !== false &&
      result?.status !== false &&
      Boolean(paymentData?.id || paymentData?.invoice_id || paymentData?.trx_id);

    if (!isSuccess) {
      return res.status(400).json({
        success: false,
        message: result?.message || result?.error || paymentData?.message || "Gagal membuat QRIS Ditznesia."
      });
    }

    const rawQrImage = paymentData.qr_link || paymentData.qr_image || paymentData.qris_url || paymentData.url || "";
    const qrisString = paymentData.qr_string || paymentData.qris_string || paymentData.qr_code || "";

    // ditzId (UUID paling atas dari Ditznesia) untuk cek status & cancel
    // ditzTrxId (trx_id INV...) untuk ditampilkan ke user
    const ditzId = String(paymentData.id || paymentData.invoice_id || paymentData.trx_id);
    const ditzTrxId = String(paymentData.trx_id || paymentData.reff_id || ditzId);

    const apiTotalBayar = parseInt(paymentData.total_bayar || paymentData.amount, 10) || totalBayarRequest;
    const selisihDitz = Math.max(0, apiTotalBayar - totalBayarRequest);
    const feeDitznesia = Math.max(Number(paymentData.fee) || 0, selisihDitz);

    // Satukan kode unik + admin Ditznesia ke dalam biaya admin (fee)
    const totalAdminGabungan = kodeUnik + feeDitznesia;
    const totalAmount = parsedNominal + totalAdminGabungan;

    const rawCreatedAt = paymentData.created_at;
    const providerCreatedAt = rawCreatedAt
      ? new Date(typeof rawCreatedAt === "number" ? rawCreatedAt : rawCreatedAt).toISOString()
      : new Date().toISOString();

    const rawExpiresAt = paymentData.expired_at || paymentData.expires_at || paymentData.expires_at_ms;
    const providerExpiresAt = rawExpiresAt
      ? new Date(typeof rawExpiresAt === "number" ? rawExpiresAt : rawExpiresAt).toISOString()
      : null;

    if ((!rawQrImage && !qrisString) || !ditzId) {
      return res.status(502).json({
        success: false,
        message: "Ditznesia tidak mengembalikan QRIS / ID lengkap."
      });
    }

    const customBgUrl = "https://files.catbox.moe/mbhgwo.png";
    const rawStatus = String(paymentData.status || "pending").toLowerCase();
    const initialStatus = ["berhasil", "paid", "success", "sukses"].includes(rawStatus) ? "success" : rawStatus;

    const historyDataForDb = {
      id: ditzTrxId,
      trx_id: ditzTrxId,
      reff_id: ditzTrxId,
      ditz_id: ditzId,
      nominal: parsedNominal,
      tambahan: kodeUnik,
      kode_unik: kodeUnik,
      fee: totalAdminGabungan,
      fee_ditznesia: feeDitznesia,
      total_amount: totalAmount,
      get_balance: saldoDiterima,
      provider_amount: apiTotalBayar,
      provider: "ditznesia",
      provider_id: ditzId,
      provider_reference_id: ditzTrxId,
      provider_created_at: providerCreatedAt,
      provider_expires_at: providerExpiresAt,
      expires_in_ms: 15 * 60 * 1000,
      provider_status: paymentData.status || "pending",
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
        id: ditzTrxId,
        trx_id: ditzTrxId,
        reff_id: ditzTrxId,
        ditz_id: ditzId,
        provider_id: ditzId,
        metode: "QRIS",
        nominal: parsedNominal,
        kode_unik: kodeUnik,
        tambahan: kodeUnik,
        fee: totalAdminGabungan,
        fee_ditznesia: feeDitznesia,
        total_amount: totalAmount,
        get_balance: saldoDiterima,
        qr_image: rawQrImage || null,
        qris_string: qrisString,
        bg_image: customBgUrl,
        status: initialStatus,
        expires_at: providerExpiresAt,
        expires_in_ms: 15 * 60 * 1000
      }
    });

    // ================= BACKGROUND POLLING DITZNESIA =================
    const intervalId = setInterval(async () => {
      try {
        const latestHistory = await User.findOne(
          { _id: user._id, "historyDeposit.id": ditzTrxId },
          { "historyDeposit.$": 1 }
        );

        const latestDeposit = latestHistory?.historyDeposit?.[0];
        const localStatus = String(latestDeposit?.status || "").toLowerCase();

        if (!latestDeposit || !["pending", "processing"].includes(localStatus)) {
          clearInterval(intervalId);
          return;
        }

        const checkId = String(latestDeposit.provider_id || latestDeposit.ditz_id || ditzId);
        const detailUrl = `${DITZ_BASE}/deposit/status?apikey=${encodeURIComponent(DITZ_API_KEY)}&id=${encodeURIComponent(checkId)}`;
        const checkRes = await fetch(detailUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0"
          }
        });

        if (!checkRes.ok) return;

        const checkData = await checkRes.json();
        const providerTrx = checkData?.data || checkData?.deposit || checkData;
        if (!providerTrx || !providerTrx.status) return;

        const rawProviderStatus = String(providerTrx.status).toLowerCase();
        const providerStatus = ["berhasil", "paid", "success", "sukses"].includes(rawProviderStatus)
          ? "success"
          : rawProviderStatus;

        if (providerStatus === "success") {
          let pTime = providerTrx.settlement_time || providerTrx.updated_at || providerTrx.created_at || null;
          if (typeof pTime === "number") {
            pTime = new Date(pTime).toISOString();
          }

          const updateResult = await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: ditzTrxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": "success",
                "historyDeposit.$.provider_id": String(providerTrx.id || checkId),
                "historyDeposit.$.ditz_id": String(providerTrx.id || checkId),
                "historyDeposit.$.provider_amount": Number(providerTrx.total_bayar || providerTrx.amount) || 0,
                "historyDeposit.$.provider_status": rawProviderStatus || "success",
                "historyDeposit.$.provider_time": pTime
              },
              $inc: {
                saldo: Number(latestDeposit.get_balance) || 0
              }
            }
          );

          if (updateResult.modifiedCount > 0) {
            console.log(`Deposit SUCCESS ${ditzTrxId}`);
          }
          clearInterval(intervalId);
          return;
        }

        if (["failed", "expired", "cancel", "cancelled", "batal", "gagal"].includes(providerStatus)) {
          const mappedStatus =
            providerStatus === "batal" || providerStatus === "cancelled"
              ? "cancel"
              : providerStatus === "gagal"
              ? "failed"
              : providerStatus;

          await User.updateOne(
            {
              _id: user._id,
              historyDeposit: {
                $elemMatch: {
                  id: ditzTrxId,
                  status: { $in: ["pending", "processing"] }
                }
              }
            },
            {
              $set: {
                "historyDeposit.$.status": mappedStatus,
                "historyDeposit.$.provider_status": rawProviderStatus
              }
            }
          );
          clearInterval(intervalId);
        }
      } catch (e) {
        console.error("Ditznesia Polling Error:", e.message);
      }
    }, 10000);

    setTimeout(() => clearInterval(intervalId), 15 * 60 * 1000 + 60000);

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
    const displayTrxId = String(localData.trx_id || localData.reff_id || id);

    // ================= STATUS TERMINAL =================
    if (!["pending", "processing"].includes(localStatus)) {
      const nominal = Number(localData.nominal) || 0;
      const kodeUnik = Number(localData.kode_unik || localData.tambahan) || 0;
      const feeTotal = Number(localData.fee) || 0;
      const totalAmount = Number(localData.total_amount) > 0 ? Number(localData.total_amount) : nominal + feeTotal;

      return res.status(200).json({
        success: true,
        data: {
          id,
          trx_id: displayTrxId,
          reff_id: displayTrxId,
          nominal,
          kode_unik: kodeUnik,
          tambahan: kodeUnik,
          fee: feeTotal,
          fee_admin: Number(localData.fee_admin) || 0,
          fee_provider: Number(localData.fee_provider) || 0,
          total_amount: totalAmount,
          get_balance: Number(localData.get_balance) || nominal,
          status: localStatus,
          metode: localData.metode || "QRIS",
          qr_image: localData.qr_image || null,
          bg_image: localData.bg_image || "https://files.catbox.moe/mbhgwo.png",
          qris_string: localData.qris_string || "",
          created_at: localData.created_at || null,
          expires_at: localData.provider_expires_at || null,
          paid_at: localData.provider_time || null,
          provider_id: localData.provider_id || id,
          provider_reference_id: displayTrxId,
          provider_amount: Number(localData.provider_amount) || totalAmount,
          provider_status: localData.provider_status || null,
          provider_time: localData.provider_time || null
        }
      });
    }

    const DITZ_BASE = process.env.DITZ_BASE_URL || "https://www.ditznesia.com/api/dev";
    const DITZ_API_KEY = process.env.DITZ_API_KEY || "6985b717a060a0906af01d335034b40f";

    if (!DITZ_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API Key Ditznesia belum dikonfigurasi di server."
      });
    }

    const fetchWithTimeout = async (url, options = {}, timeout = 5000) => {
      const controller = new AbortController();
      const idTimeout = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(idTimeout);
        return response;
      } catch (err) {
        clearTimeout(idTimeout);
        return null;
      }
    };

    let providerTrx = null;
    const targetPaymentId = localData.provider_id || id;

    if (targetPaymentId) {
      const detailUrl = `${DITZ_BASE}/deposit/status?apikey=${encodeURIComponent(DITZ_API_KEY)}&id=${encodeURIComponent(targetPaymentId)}`;
      const detailRes = await fetchWithTimeout(detailUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        }
      });

      if (detailRes && detailRes.ok) {
        try {
          const detailData = await detailRes.json();
          if (detailData) {
            providerTrx = detailData.data || detailData.deposit || detailData;
          }
        } catch (e) {}
      }
    }

    if (providerTrx) {
      const rawProviderStatus = String(providerTrx.status || localStatus).toLowerCase();
      const providerStatus = ["berhasil", "paid", "success", "sukses"].includes(rawProviderStatus)
        ? "success"
        : rawProviderStatus;

      const pId = String(providerTrx.id || providerTrx.invoice_id || targetPaymentId);
      const pRef = String(providerTrx.trx_id || providerTrx.reff_id || displayTrxId);

      let pPaidAt = providerTrx.settlement_time || providerTrx.updated_at || providerTrx.created_at || null;
      if (typeof pPaidAt === "number") {
        pPaidAt = new Date(pPaidAt).toISOString();
      }

      let pExpiresAt = providerTrx.expired_at || providerTrx.expires_at || providerTrx.expires_at_ms || null;
      if (typeof pExpiresAt === "number") {
        pExpiresAt = new Date(pExpiresAt).toISOString();
      }

      if (providerStatus === "success") {
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
              "historyDeposit.$.trx_id": pRef,
              "historyDeposit.$.reff_id": pRef,
              "historyDeposit.$.provider_id": pId,
              "historyDeposit.$.provider_reference_id": pRef,
              "historyDeposit.$.provider_amount": Number(providerTrx.total_bayar || providerTrx.amount) || 0,
              "historyDeposit.$.provider_status": rawProviderStatus || "success",
              "historyDeposit.$.provider_time": pPaidAt,
              "historyDeposit.$.provider_expires_at": pExpiresAt
            },
            $inc: {
              saldo: Number(localData.get_balance) || 0
            }
          }
        );

        if (updateResult.modifiedCount > 0) {
          localStatus = "success";
        }
      } else if (["failed", "expired", "cancel", "cancelled", "gagal", "batal"].includes(providerStatus)) {
        const mappedStatus =
          providerStatus === "gagal"
            ? "failed"
            : providerStatus === "batal" || providerStatus === "cancelled"
            ? "cancelled"
            : providerStatus;

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
              "historyDeposit.$.status": mappedStatus,
              "historyDeposit.$.trx_id": pRef,
              "historyDeposit.$.reff_id": pRef,
              "historyDeposit.$.provider_id": pId,
              "historyDeposit.$.provider_reference_id": pRef,
              "historyDeposit.$.provider_amount": Number(providerTrx.total_bayar || providerTrx.amount) || 0,
              "historyDeposit.$.provider_status": rawProviderStatus,
              "historyDeposit.$.provider_time": pPaidAt,
              "historyDeposit.$.provider_expires_at": pExpiresAt
            }
          }
        );

        if (updateResult.modifiedCount > 0) {
          localStatus = mappedStatus;
        }
      }
    }

    const refreshedUser = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );

    localData = refreshedUser?.historyDeposit?.[0] || localData;
    localStatus = String(localData.status || localStatus || "pending").toLowerCase();
    const updatedTrxId = String(localData.trx_id || localData.reff_id || displayTrxId);

    const nominal = Number(localData.nominal) || 0;
    const kodeUnik = Number(localData.kode_unik || localData.tambahan) || 0;
    const feeTotal = Number(localData.fee) || 0;
    const totalAmount = Number(localData.total_amount) > 0 ? Number(localData.total_amount) : nominal + kodeUnik + feeTotal;

    return res.status(200).json({
      success: true,
      data: {
        id,
        trx_id: updatedTrxId,
        reff_id: updatedTrxId,
        nominal,
        kode_unik: kodeUnik,
        tambahan: kodeUnik,
        fee: feeTotal,
        fee_admin: Number(localData.fee_admin) || 0,
        fee_provider: Number(localData.fee_provider) || 0,
        total_amount: totalAmount,
        get_balance: Number(localData.get_balance) || nominal,
        status: localStatus,
        metode: localData.metode || "QRIS",
        qr_image: localData.qr_image || null,
        bg_image: localData.bg_image || "https://files.catbox.moe/mbhgwo.png",
        qris_string: localData.qris_string || "",
        created_at: localData.created_at || null,
        expires_at: localData.provider_expires_at || null,
        paid_at: localData.provider_time || null,
        provider_id: localData.provider_id || id,
        provider_reference_id: updatedTrxId,
        provider_amount: Number(localData.provider_amount) || totalAmount,
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

    const DITZ_BASE = process.env.DITZ_BASE_URL || "https://www.ditznesia.com/api/dev";
    const DITZ_API_KEY = process.env.DITZ_API_KEY || "6985b717a060a0906af01d335034b40f";

    if (!DITZ_API_KEY) {
      return res.status(500).json({
        success: false,
        message: "API Key Ditznesia belum dikonfigurasi di server."
      });
    }

    const targetPaymentId = currentData.provider_id || id;
    const cancelUrl = `${DITZ_BASE}/deposit/cancel?apikey=${encodeURIComponent(DITZ_API_KEY)}&id=${encodeURIComponent(targetPaymentId)}`;

    let response;
    try {
      response = await fetch(cancelUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        }
      });
    } catch (fetchError) {
      console.error("Ditznesia Cancel Fetch Error:", fetchError);
      return res.status(502).json({
        success: false,
        message: "Koneksi server ke Ditznesia gagal."
      });
    }

    const responseText = await response.text();
    let result;

    try {
      result = JSON.parse(responseText);
    } catch (jsonError) {
      console.error("Ditznesia Cancel Invalid Response:", responseText.slice(0, 500));
      return res.status(502).json({
        success: false,
        message: "Ditznesia mengembalikan respons yang bukan JSON."
      });
    }

    await editHistoryDeposit(user._id, id, "cancelled");

    return res.status(200).json({
      success: true,
      message: result?.message || "Deposit berhasil dibatalkan.",
      data: {
        id: id,
        trx_id: id,
        status: "cancelled"
      }
    });

  } catch (error) {
    console.error("Cancel Deposit Error:", error);
    return res.status(500).json({ success: false, message: "Terjadi kesalahan: " + error.message });
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

    const mappedProducts = filtered.map((item) => {
      const markedPrice = applyMarkup30Percent(item.price);
      const { price_original, modal, harga_modal, base_price, cost_price, ...rest } = item;
      return {
        ...rest,
        price: String(markedPrice),
      };
    });

    return res.json({
      success: true,
      data: mappedProducts,
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
const axios = require("axios"); // atau gunakan fetch / cloudscraper sesuai kebutuhan

const DITZ_BASE_URL = "https://www.ditznesia.com/api/dev";
const DITZ_API_KEY = process.env.DITZ_API_KEY || "6985b717a060a0906af01d335034b40f";


function applyMarkup30Percent(rawPrice) {
  const num = parseFloat(String(rawPrice ?? 0).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num * 1.3);
}

function isUsernameCheckProduct(productOrName) {
  const txt = typeof productOrName === "string"
    ? productOrName
    : `${productOrName?.name || ""} ${productOrName?.layanan || ""} ${productOrName?.code || ""}`;
  return /cek\s*username|check\s*username|cek\s*id|cek\s*nickname/i.test(txt);
}

function extractUsernameFromProviderData(d) {
  if (!d) return "";
  if (typeof d === "string") {
    const m = d.match(/(?:username|nickname|name)\s*[:=]\s*([^\n|]+)/i);
    return m ? m[1].trim() : d.trim();
  }
  return String(
    d.username ||
      d.nickname ||
      d.name ||
      d.player_name ||
      d.result?.name ||
      d.result?.username ||
      ""
  ).trim();
}

// 0. Daftar harga layanan / produk topup (disesuaikan ke Ditznesia /tp-products)
router.post("/layanan/price-list", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid.",
    });
  }

  const { code, game, provider } = req.body;
  const selectedGame = game || provider;

  try {
    const params = { apikey: DITZ_API_KEY };
    if (selectedGame) {
      params.game = selectedGame;
    }

    const response = await axios.get(`${DITZ_BASE_URL}/tp-products`, {
      params,
    });

    const rawData = response.data?.data || response.data || [];
    let products = Array.isArray(rawData) ? rawData : [];

    if (selectedGame) {
      products = products.filter(
        (item) =>
          String(item.game || "").toLowerCase() ===
          String(selectedGame).toLowerCase()
      );
    }

    if (code) {
      products = products.filter(
        (item) => String(item.code) === String(code)
      );
    }

    const modifiedData = products.map((item) => {
      const modifiedPrice = applyMarkup30Percent(item.price);

      return {
        code: item.code,
        name: item.name,
        category: item.game || item.category || null,
        type: item.type || "topup_game",
        provider: item.game || item.provider || null,
        price: modifiedPrice.toString(),
        price_original: null,
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


// 2b. Cek Username / Nickname Akun Game sebelum order (/tp-check)
router.post("/check-name", requireLogin, async (req, res) => {
  const user = await User.findById(req.session.userId);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau sesi tidak valid.",
    });
  }

  const code = String(req.body.code || "").trim();
  const target = String(req.body.tujuan || req.body.target || "").trim();
  const zone = String(req.body.zone || "").trim();

  if (!code || !target) {
    return res.status(400).json({
      success: false,
      message: "Kode produk dan User ID / Target wajib diisi untuk cek username.",
    });
  }

  try {
    const checkRes = await axios.get(`${DITZ_BASE_URL}/tp-check`, {
      params: {
        apikey: DITZ_API_KEY,
        code,
        target,
        ...(zone ? { zone } : {}),
      },
      timeout: 15000,
    });

    const raw = checkRes.data || {};
    const username =
      raw.name ||
      raw.username ||
      raw.nickname ||
      raw.data?.name ||
      raw.data?.username ||
      raw.data?.nickname ||
      "";

    if (raw.status === false || raw.success === false || !username) {
      return res.status(400).json({
        success: false,
        message: raw.message || "Username tidak ditemukan atau ID / Zone salah.",
        data: raw,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        username: String(username).trim(),
        name: String(username).trim(),
        target,
        zone: zone || null,
        code,
      },
    });
  } catch (error) {
    const apiError = error.response?.data;
    return res.status(500).json({
      success: false,
      message:
        apiError?.message ||
        "Gagal mengecek username ke provider. Periksa kembali ID / Zone Anda.",
      error: apiError || error.message,
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

    const modifiedPrice = applyMarkup30Percent(product.price);

    if (user.saldo < modifiedPrice) {
      return res.status(400).json({
        success: false,
        message: "Saldo Anda tidak mencukupi untuk melakukan transaksi ini.",
      });
    }

    const reff_id = generateReffId();

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
    const layananName = transactionDetails.layanan || transactionDetails.service || product.name;
    const targetDisplay = zone ? `${target} (${zone})` : target;
    const checkedUsername = extractUsernameFromProviderData(transactionDetails);
    const isCheckUsernameItem = isUsernameCheckProduct(product) || isUsernameCheckProduct(layananName);

    let initialStatus = String(transactionDetails.status || "pending").toLowerCase();
    let initialSn = transactionDetails.sn || transactionDetails.data || null;

    // Jika layanan cek username dan username sudah muncul, langsung set sukses
    if (isCheckUsernameItem && (checkedUsername || initialSn)) {
      initialStatus = "success";
      if (!initialSn && checkedUsername) {
        initialSn = `Username: ${checkedUsername}`;
      }
    }

    let emailedSuccess = ["success", "sukses"].includes(initialStatus);

    const historyDataForDb = {
      id: txId,
      reff_id: transactionDetails.reff_id || reff_id,
      layanan: layananName,
      code: transactionDetails.code || code,
      target: targetDisplay,
      price: modifiedPrice,
      sn: initialSn,
      status: initialStatus,
      created_at: transactionDetails.created_at
        ? new Date(transactionDetails.created_at)
        : new Date(),
    };

    await tambahHistoryOrder(user._id, historyDataForDb);

    if (emailedSuccess) {
      await sendOrderSuccessEmail(user, {
        id: txId,
        reff_id: transactionDetails.reff_id || reff_id,
        layanan: layananName,
        username: checkedUsername,
        target: targetDisplay,
        price: modifiedPrice,
        sn: initialSn,
      });
    }

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
          let currentTxStatus = String(statusData.status).toLowerCase();
          let currentSn = statusData.sn || statusData.data || null;
          const polledUsername = extractUsernameFromProviderData(statusData) || checkedUsername;

          if (isCheckUsernameItem && (polledUsername || currentSn)) {
            currentTxStatus = "success";
            if (!currentSn && polledUsername) {
              currentSn = `Username: ${polledUsername}`;
            }
          }

          await editHistoryOrder(user._id, txId, {
            status: currentTxStatus,
            sn: currentSn,
          });

          if (["success", "sukses"].includes(currentTxStatus)) {
            if (!emailedSuccess) {
              emailedSuccess = true;
              await sendOrderSuccessEmail(user._id, {
                id: txId,
                reff_id: statusData.reff_id || reff_id,
                layanan: statusData.layanan || statusData.service || layananName,
                username: polledUsername,
                target: statusData.target || targetDisplay,
                price: modifiedPrice,
                sn: currentSn,
              });
            }
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
        reff_id: transactionDetails.reff_id || reff_id,
        layanan: transactionDetails.layanan || transactionDetails.service || product.name,
        code: transactionDetails.code || code,
        target: zone ? `${target} (${zone})` : target,
        sn: initialSn,
        status: initialStatus,
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
      message: "User tidak ditemukan atau sesi tidak valid.",
    });
  }
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID order harus diisi.",
    });
  }
  try {
    const userWithOrder = await User.findOne(
      {
        _id: user._id,
        "historyOrder.id": id,
      },
      {
        "historyOrder.$": 1,
      }
    );
    if (!userWithOrder || !userWithOrder.historyOrder.length) {
      return res.status(404).json({
        success: false,
        message: "Order Tidak Ditemukan Di Mutasi Anda.",
      });
    }

    const localOrder = userWithOrder.historyOrder[0];
    let currentStatus = String(localOrder.status || "pending").toLowerCase();
    let currentSn = localOrder.sn || null;
    let providerMessage = "";

    // Jika status belum final atau SN belum ada, cek langsung ke Ditznesia /tp-orders
    if (!["success", "sukses", "failed", "gagal", "failed_refunded", "cancel", "batal"].includes(currentStatus) || !currentSn) {
      try {
        const statusResponse = await axios.get(`${DITZ_BASE_URL}/tp-orders`, {
          params: {
            apikey: DITZ_API_KEY,
            id: id,
            limit: 30,
          },
          timeout: 12000,
        });

        const rawStatus = statusResponse.data?.data || statusResponse.data;
        const statusData = Array.isArray(rawStatus)
          ? rawStatus.find((item) => String(item.id) === String(id)) || rawStatus[0]
          : rawStatus;

        if (statusData && statusData.status) {
          currentStatus = String(statusData.status).toLowerCase();
          currentSn = statusData.sn || statusData.data || currentSn || null;
          providerMessage = statusData.message || "";
          const checkUserNick = extractUsernameFromProviderData(statusData);

          if (isUsernameCheckProduct(localOrder) && (checkUserNick || currentSn)) {
            currentStatus = "success";
            if (!currentSn && checkUserNick) {
              currentSn = `Username: ${checkUserNick}`;
            }
          }

          await editHistoryOrder(user._id, id, {
            status: currentStatus,
            sn: currentSn,
          });

          if (["success", "sukses"].includes(currentStatus) && !["success", "sukses"].includes(String(localOrder.status || "").toLowerCase())) {
            await sendOrderSuccessEmail(user, {
              id: localOrder.id,
              reff_id: localOrder.reff_id || localOrder.id,
              layanan: localOrder.layanan,
              username: checkUserNick,
              target: localOrder.target,
              price: localOrder.price,
              sn: currentSn,
            });
          }

          if (["failed", "gagal", "cancel", "batal"].includes(currentStatus)) {
            const orderCheckRefund = await User.findOne(
              {
                _id: user._id,
                "historyOrder.id": id,
                "historyOrder.status": { $ne: "failed_refunded" },
              },
              { "historyOrder.$": 1 }
            );
            if (orderCheckRefund && orderCheckRefund.historyOrder.length > 0) {
              const refundAmount = parseInt(localOrder.price, 10) || 0;
              await User.updateOne(
                { _id: user._id, "historyOrder.id": id },
                {
                  $inc: { saldo: refundAmount },
                  $set: { "historyOrder.$.status": "failed_refunded" },
                }
              );
              currentStatus = "failed_refunded";
            }
          }
        }
      } catch (pollErr) {
        console.error("Cek status /tp-orders error:", pollErr?.response?.data || pollErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      status: true,
      data: {
        id: localOrder.id,
        reff_id: localOrder.reff_id || localOrder.id,
        layanan: localOrder.layanan,
        code: localOrder.code,
        target: localOrder.target,
        price: localOrder.price,
        sn: currentSn,
        status: currentStatus,
        message: providerMessage,
        created_at: localOrder.created_at,
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
