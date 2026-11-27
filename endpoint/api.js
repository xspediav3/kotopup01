const express = require("express");
const qs = require("qs");
const cloudscraper = require("cloudscraper");
const axios = require("axios");
const router = express.Router();

const domain = process.env.PTERO_DOMAIN;
const apikey = process.env.PTERO_API_KEY;

const {
  validateApiKey,
  User,
  tambahHistoryDeposit,
  generateReffId,
  editHistoryDeposit,
  tambahHistoryOrder,
  editHistoryOrder,
  sendOrderSuccessEmail,
} = require("../index.js");

const DITZ_BASE_URL = process.env.DITZ_BASE_URL || "https://www.ditznesia.com/api/dev";
const DITZ_API_KEY = process.env.DITZ_API_KEY || "6985b717a060a0906af01d335034b40f";

function applyMarkup30Percent(rawPrice) {
  const num = parseFloat(String(rawPrice ?? 0).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num * 1.3);
}

function isUsernameCheckProduct(productOrName) {
  const txt =
    typeof productOrName === "string"
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

const cloudscraperHeaders = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
};

router.get("/profile", validateApiKey, async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found after API key validation",
      });
    }

    return res.status(200).json({
      success: true,
      user: {
        fullname: user.fullname,
        username: user.username,
        nomor: user.nomor,
        email: user.email,
        profileUrl: user.profileUrl,
        saldo: user.saldo,
        coin: user.coin,
        tanggalDaftar: user.tanggalDaftar,
        role: user.role,
        isVerified: user.isVerified,
        lastLogin: user.lastLogin,
        referralCode: user.referralCode,
      },
    });
  } catch (error) {
    console.error("Error fetching user profile via API:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

router.get("/mutasi", validateApiKey, async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found after API key validation",
      });
    }

    const historyDeposit = user.historyDeposit || [];
    const historyOrder = user.historyOrder || [];

    historyDeposit.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    historyOrder.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.status(200).json({
      success: true,
      mutasiDeposit: historyDeposit,
      mutasiOrder: historyOrder,
    });
  } catch (error) {
    console.error("Error fetching mutation history via API:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
});

router.get("/deposit/metode", validateApiKey, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const role = req.user?.role || "user";
    const feePersen =
      role === "reseller"
        ? process.env.FEE_PERCENT_RESELLER || "0.7"
        : process.env.FEE_PERCENT_USER || "1.5";

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
        thumbnail: `${fullUrl}/media/metode/qrisfast.png`,
      },
    ];

    return res.status(200).json({
      success: true,
      message: "Daftar metode deposit Ditznesia",
      metode: metodeFormatted,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Gagal mengambil metode deposit",
      error: error?.response?.data || error.message,
    });
  }
});

router.get("/deposit/create", validateApiKey, async (req, res) => {
  const { user } = req;
  const parsedNominal = parseInt(req.query.nominal, 10);

  if (!req.query.nominal || !Number.isFinite(parsedNominal) || parsedNominal < 1000) {
    return res.status(400).json({
      success: false,
      message: "Minimal deposit Rp1.000",
    });
  }

  try {
    const baseUnik = Math.floor(Math.random() * (400 - 100 + 1)) + 100;
    const kelipatan10k = parsedNominal >= 10000 ? Math.max(1, Math.floor(parsedNominal / 10000)) : 1;
    const kodeUnik = parsedNominal >= 10000 ? baseUnik * kelipatan10k : baseUnik;
    const totalBayarRequest = parsedNominal + kodeUnik;
    const saldoDiterima = parsedNominal;

    const createUrl = `${DITZ_BASE_URL}/deposit/create?apikey=${encodeURIComponent(DITZ_API_KEY)}&nominal=${totalBayarRequest}`;
    const response = await fetch(createUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
      },
    });

    const result = await response.json();
    const paymentData = result?.data || result?.deposit || result;
    const ditzId = String(paymentData?.id || paymentData?.invoice_id || paymentData?.trx_id || "");
    const ditzTrxId = String(paymentData?.trx_id || paymentData?.reff_id || ditzId);

    if (!response.ok || result?.success === false || result?.status === false || !ditzId) {
      return res.status(400).json({
        success: false,
        message: result?.message || result?.error || "Gagal membuat QRIS Ditznesia.",
      });
    }

    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const rawQrImage =
      paymentData.qr_link ||
      paymentData.qr_image ||
      paymentData.qris_url ||
      paymentData.url ||
      `${fullUrl}/media/metode/qrisfast.png`;
    const qrisString = paymentData.qr_string || paymentData.qris_string || paymentData.qr_code || "";
    const apiTotalBayar = parseInt(paymentData.total_bayar || paymentData.amount, 10) || totalBayarRequest;
    const feeDitznesia = Math.max(Number(paymentData.fee) || 0, Math.max(0, apiTotalBayar - totalBayarRequest));
    const totalAdminGabungan = kodeUnik + feeDitznesia;
    const totalAmount = parsedNominal + totalAdminGabungan;
    const rawStatus = String(paymentData.status || "pending").toLowerCase();
    const initialStatus = ["berhasil", "paid", "success", "sukses"].includes(rawStatus) ? "success" : rawStatus;

    await tambahHistoryDeposit(user._id, {
      id: ditzTrxId,
      reff_id: ditzTrxId,
      nominal: parsedNominal,
      tambahan: kodeUnik,
      fee: totalAdminGabungan,
      get_balance: saldoDiterima,
      metode: "QRIS",
      status: initialStatus,
      qr_image: rawQrImage,
      created_at: new Date(),
    });

    res.status(200).json({
      success: true,
      data: {
        id: ditzTrxId,
        trx_id: ditzTrxId,
        reff_id: ditzTrxId,
        ditz_id: ditzId,
        metode: "QRIS",
        nominal: parsedNominal,
        kode_unik: kodeUnik,
        tambahan: kodeUnik,
        fee: totalAdminGabungan,
        total_amount: totalAmount,
        get_balance: saldoDiterima,
        qr_image: rawQrImage,
        img_url: rawQrImage,
        thumbnail: rawQrImage,
        qris_string: qrisString,
        status: initialStatus,
      },
    });

    const intervalId = setInterval(async () => {
      try {
        const latest = await User.findOne(
          { _id: user._id, "historyDeposit.id": ditzTrxId },
          { "historyDeposit.$": 1 }
        );
        const latestDeposit = latest?.historyDeposit?.[0];
        if (!latestDeposit || !["pending", "processing"].includes(String(latestDeposit.status || "").toLowerCase())) {
          clearInterval(intervalId);
          return;
        }

        const statusUrl = `${DITZ_BASE_URL}/deposit/status?apikey=${encodeURIComponent(DITZ_API_KEY)}&id=${encodeURIComponent(ditzId)}`;
        const checkRes = await fetch(statusUrl, {
          method: "GET",
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
        });
        if (!checkRes.ok) return;

        const checkData = await checkRes.json();
        const providerTrx = checkData?.data || checkData?.deposit || checkData;
        const rawProvStatus = String(providerTrx?.status || "").toLowerCase();
        const provStatus = ["berhasil", "paid", "success", "sukses"].includes(rawProvStatus)
          ? "success"
          : rawProvStatus;

        if (provStatus === "success") {
          const upd = await User.updateOne(
            {
              _id: user._id,
              historyDeposit: { $elemMatch: { id: ditzTrxId, status: { $in: ["pending", "processing"] } } },
            },
            {
              $set: { "historyDeposit.$.status": "success" },
              $inc: { saldo: Number(latestDeposit.get_balance) || saldoDiterima },
            }
          );
          if (upd.modifiedCount > 0) {
            console.log(`API Deposit SUCCESS ${ditzTrxId}`);
          }
          clearInterval(intervalId);
        } else if (["failed", "expired", "cancel", "cancelled", "batal", "gagal"].includes(provStatus)) {
          await editHistoryDeposit(user._id, ditzTrxId, provStatus === "batal" ? "cancel" : provStatus);
          clearInterval(intervalId);
        }
      } catch (pollErr) {
        console.error("API Ditznesia Deposit Polling Error:", pollErr?.message || pollErr);
      }
    }, 10000);

    setTimeout(() => clearInterval(intervalId), 15 * 60 * 1000 + 60000);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || "Terjadi kesalahan saat membuat deposit.",
    });
  }
});

router.get("/deposit/status", validateApiKey, async (req, res) => {
  const { user } = req;
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID deposit harus diisi.",
    });
  }

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );
    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({
        success: false,
        message: "ID deposit tidak ditemukan dalam riwayat Anda.",
      });
    }

    const localData = userHistory.historyDeposit[0];
    let localStatus = String(localData.status || "pending").toLowerCase();

    if (["pending", "processing"].includes(localStatus)) {
      const statusUrl = `${DITZ_BASE_URL}/deposit/status?apikey=${encodeURIComponent(DITZ_API_KEY)}&id=${encodeURIComponent(id)}`;
      const checkRes = await fetch(statusUrl, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        const providerTrx = checkData?.data || checkData?.deposit || checkData;
        const rawProvStatus = String(providerTrx?.status || localStatus).toLowerCase();
        const provStatus = ["berhasil", "paid", "success", "sukses"].includes(rawProvStatus)
          ? "success"
          : rawProvStatus;

        if (provStatus === "success") {
          const upd = await User.updateOne(
            {
              _id: user._id,
              historyDeposit: { $elemMatch: { id, status: { $in: ["pending", "processing"] } } },
            },
            {
              $set: { "historyDeposit.$.status": "success" },
              $inc: { saldo: Number(localData.get_balance) || 0 },
            }
          );
          if (upd.modifiedCount > 0) localStatus = "success";
        } else if (["failed", "expired", "cancel", "cancelled", "batal", "gagal"].includes(provStatus)) {
          await editHistoryDeposit(user._id, id, provStatus);
          localStatus = provStatus;
        }
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        id: localData.id,
        reff_id: localData.reff_id || localData.id,
        nominal: Number(localData.nominal) || 0,
        tambahan: Number(localData.tambahan) || 0,
        fee: Number(localData.fee) || 0,
        get_balance: Number(localData.get_balance) || 0,
        metode: localData.metode || "QRIS",
        qr_image: localData.qr_image || null,
        status: localStatus,
        created_at: localData.created_at,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || "Terjadi kesalahan internal saat memeriksa status deposit.",
    });
  }
});

router.get("/deposit/cancel", validateApiKey, async (req, res) => {
  const { user } = req;
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID deposit harus diisi.",
    });
  }

  try {
    const userHistory = await User.findOne(
      { _id: user._id, "historyDeposit.id": id },
      { "historyDeposit.$": 1 }
    );
    if (!userHistory || !userHistory.historyDeposit.length) {
      return res.status(404).json({
        success: false,
        message: "ID deposit tidak ditemukan dalam riwayat Anda.",
      });
    }

    const cancelUrl = `${DITZ_BASE_URL}/deposit/cancel?apikey=${encodeURIComponent(DITZ_API_KEY)}&id=${encodeURIComponent(id)}`;
    await fetch(cancelUrl, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });

    await editHistoryDeposit(user._id, id, "cancelled");

    return res.status(200).json({
      success: true,
      data: {
        id,
        status: "cancelled",
        created_at: new Date(),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.message || "Terjadi kesalahan internal saat membatalkan deposit.",
    });
  }
});

router.get("/produk", validateApiKey, async (req, res) => {
  const { search } = req.query;
  try {
    const response = await axios.get(`${DITZ_BASE_URL}/tp-games`, {
      params: { apikey: DITZ_API_KEY },
    });
    const rawData = response.data?.data || response.data || [];
    const listGames = Array.isArray(rawData) ? rawData : [];
    const filtered = search
      ? listGames.filter((item) => String(item.game || "").toLowerCase().includes(String(search).toLowerCase()))
      : listGames;

    const fullUrl = `${req.protocol}://${req.get("host")}`;

    return res.status(200).json({
      success: true,
      data: filtered.map((item) => {
        const resolvedImg =
          item.img_url || item.thumbnail || item.image || item.icon || `${fullUrl}/media/metode/default.png`;
        return {
          game: item.game,
          products: item.products,
          need_zone: Boolean(item.need_zone),
          img_url: resolvedImg,
          thumbnail: item.thumbnail || resolvedImg,
        };
      }),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || "Gagal memproses data game Ditznesia.",
    });
  }
});

router.get("/layanan/price-list", validateApiKey, async (req, res) => {
  const { code, game, provider } = req.query;
  const selectedGame = game || provider;

  try {
    const params = { apikey: DITZ_API_KEY };
    if (selectedGame) params.game = selectedGame;

    const response = await axios.get(`${DITZ_BASE_URL}/tp-products`, { params });
    const rawData = response.data?.data || response.data || [];
    let products = Array.isArray(rawData) ? rawData : [];

    if (selectedGame) {
      products = products.filter(
        (item) => String(item.game || "").toLowerCase() === String(selectedGame).toLowerCase()
      );
    }
    if (code) {
      products = products.filter((item) => String(item.code) === String(code));
    }

    const fullUrl = `${req.protocol}://${req.get("host")}`;
    const modifiedData = products.map((item) => {
      const resolvedImg =
        item.img_url || item.thumbnail || item.image || item.icon || `${fullUrl}/media/metode/default.png`;
      return {
        code: item.code,
        name: item.name,
        category: item.game || item.category || null,
        type: item.type || "topup_game",
        provider: item.game || item.provider || null,
        price: applyMarkup30Percent(item.price).toString(),
        need_zone: Boolean(item.need_zone),
        check_name: Boolean(item.check_name),
        note: item.note || null,
        status: item.status || "available",
        img_url: resolvedImg,
        thumbnail: item.thumbnail || resolvedImg,
      };
    });

    return res.status(200).json({
      success: true,
      data: modifiedData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error?.response?.data?.message || error?.message || "Terjadi kesalahan saat mengambil daftar harga.",
    });
  }
});

router.get("/check-name", validateApiKey, async (req, res) => {
  const code = String(req.query.code || "").trim();
  const target = String(req.query.tujuan || req.query.target || "").trim();
  const zone = String(req.query.zone || "").trim();

  if (!code || !target) {
    return res.status(400).json({
      success: false,
      message: "Kode produk dan target wajib diisi.",
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
    const username = extractUsernameFromProviderData(raw);

    if (raw.status === false || raw.success === false || !username) {
      return res.status(400).json({
        success: false,
        message: raw.message || "Username tidak ditemukan.",
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        username,
        name: username,
        target,
        zone: zone || null,
        code,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || "Gagal mengecek username ke Ditznesia.",
    });
  }
});

router.get("/order/create", validateApiKey, async (req, res) => {
  const { user } = req;
  const { code, tujuan: target, zone } = req.query;

  if (!code || !target) {
    return res.status(400).json({
      success: false,
      message: "Kode layanan dan tujuan harus diisi.",
    });
  }

  try {
    const productsResponse = await axios.get(`${DITZ_BASE_URL}/tp-products`, {
      params: { apikey: DITZ_API_KEY },
    });

    const rawProducts = productsResponse.data?.data || productsResponse.data || [];
    const productList = Array.isArray(rawProducts) ? rawProducts : [];
    const product = productList.find((item) => String(item.code) === String(code));

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
        code,
        target,
        ...(zone ? { zone } : {}),
        reff_id,
      },
    });

    const createResult = orderResponse.data;
    const transactionDetails = createResult?.data || createResult;

    if (!transactionDetails || createResult?.status === false || createResult?.success === false) {
      return res.status(502).json({
        success: false,
        message: createResult?.message || "Gagal membuat transaksi ke Ditznesia.",
      });
    }

    await User.findByIdAndUpdate(user._id, {
      $inc: { saldo: -modifiedPrice },
    });

    const txId = String(transactionDetails.id || transactionDetails.trx_id || reff_id);
    const layananName = transactionDetails.layanan || transactionDetails.service || product.name;
    const targetDisplay = zone ? `${target} (${zone})` : target;
    const checkedUsername = extractUsernameFromProviderData(transactionDetails);
    const isCheckUsernameItem = isUsernameCheckProduct(product) || isUsernameCheckProduct(layananName);

    let initialStatus = String(transactionDetails.status || "pending").toLowerCase();
    let initialSn = transactionDetails.sn || transactionDetails.data || null;

    if (isCheckUsernameItem && (checkedUsername || initialSn)) {
      initialStatus = "success";
      if (!initialSn && checkedUsername) {
        initialSn = `Username: ${checkedUsername}`;
      }
    }

    let emailedSuccess = ["success", "sukses"].includes(initialStatus);

    await tambahHistoryOrder(user._id, {
      id: txId,
      reff_id: transactionDetails.reff_id || reff_id,
      layanan: layananName,
      code: transactionDetails.code || code,
      target: targetDisplay,
      price: modifiedPrice,
      sn: initialSn,
      status: initialStatus,
      created_at: transactionDetails.created_at ? new Date(transactionDetails.created_at) : new Date(),
    });

    if (emailedSuccess && typeof sendOrderSuccessEmail === "function") {
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
            if (!emailedSuccess && typeof sendOrderSuccessEmail === "function") {
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
            if (orderInDb && orderInDb.historyOrder.length > 0) {
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
        layanan: layananName,
        code: transactionDetails.code || code,
        target: targetDisplay,
        sn: initialSn,
        status: initialStatus,
        price: modifiedPrice.toString(),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || "Terjadi kesalahan internal saat memproses order.",
    });
  }
});

router.get("/order/check", validateApiKey, async (req, res) => {
  const { user } = req;
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "ID order harus diisi.",
    });
  }

  try {
    const userWithOrder = await User.findOne(
      { _id: user._id, "historyOrder.id": id },
      { "historyOrder.$": 1 }
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

    if (!["success", "sukses", "failed", "gagal", "failed_refunded", "cancel", "batal"].includes(currentStatus) || !currentSn) {
      const statusResponse = await axios.get(`${DITZ_BASE_URL}/tp-orders`, {
        params: {
          apikey: DITZ_API_KEY,
          id,
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

        if (
          ["success", "sukses"].includes(currentStatus) &&
          !["success", "sukses"].includes(String(localOrder.status || "").toLowerCase()) &&
          typeof sendOrderSuccessEmail === "function"
        ) {
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
      }
    }

    return res.status(200).json({
      status: true,
      success: true,
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
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || "Terjadi kesalahan internal saat memeriksa status order.",
    });
  }
});

router.get("/order-panel", validateApiKey, async (req, res) => {
  const {
    username,
    paket
  } = req.query;
  const user = req.user;
  const availablePackets = ["1gb", "2gb", "3gb", "4gb", "5gb", "6gb", "7gb", "8gb", "9gb", "20gb", "unli"];
  if (!username) {
    return res.status(400).json({
      success: false,
      message: "Parameter 'username' harus diisi",
    });
  }
  if (!paket || !availablePackets.includes(paket.toLowerCase())) {
    return res.status(400).json({
      success: false,
      message: `Paket tidak valid. Paket yang tersedia: ${availablePackets.join(", ")}`,
    });
  }
  let memo, disk, cpu, harga;
  switch (paket.toLowerCase()) {
    case "1gb":
      memo = 1024;
      disk = 1024;
      cpu = 50;
      harga = 1000;
      break;
    case "2gb":
      memo = 2048;
      disk = 2048;
      cpu = 100;
      harga = 2000;
      break;
    case "3gb":
      memo = 3072;
      disk = 3072;
      cpu = 150;
      harga = 3000;
      break;
    case "4gb":
      memo = 4096;
      disk = 4096;
      cpu = 200;
      harga = 4000;
      break;
    case "5gb":
      memo = 5120;
      disk = 5120;
      cpu = 250;
      harga = 5000;
      break;
    case "6gb":
      memo = 6144;
      disk = 6144;
      cpu = 300;
      harga = 6000;
      break;
    case "7gb":
      memo = 7168;
      disk = 7168;
      cpu = 350;
      harga = 7000;
      break;
    case "8gb":
      memo = 8192;
      disk = 8192;
      cpu = 400;
      harga = 8000;
      break;
    case "9gb":
      memo = 9216;
      disk = 9216;
      cpu = 450;
      harga = 9000;
      break;
    case "10gb":
      memo = 10240;
      disk = 10240;
      cpu = 500;
      harga = 10000;
      break;
    case "unli":
      memo = 0;
      disk = 0;
      cpu = 0;
      harga = 15000;
      break;
    default:
      return res.status(400).json({
        success: false,
        message: "Paket tidak dikenali",
      });
  }
  let modifiedHarga = harga;
  if (user.role === "user") {
    modifiedHarga = harga + 10;
  } else if (user.role === "reseller") {
    modifiedHarga = harga + 7;
  }
  if (user.saldo < modifiedHarga) {
    await tambahHistoryOrder(user._id, {
      id: generateReffId(),
      layanan: `Panel ${paket}`,
      code: paket.toUpperCase(),
      target: username,
      price: modifiedHarga.toString(),
      status: "Gagal - Saldo tidak mencukupi",
      created_at: new Date(),
    });
    return res.status(400).json({
      success: false,
      message: "Saldo tidak mencukupi",
    });
  }
  try {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apikey}`,
    };
    const email = `${username}@gmail.com`;
    const password = `${username}${disk}`;
    const reff_id = generateReffId();
    const createUserResponse = await cloudscraper.post(
      `${domain}/api/application/users`, {
        body: JSON.stringify({
          email,
          username,
          first_name: username,
          last_name: username,
          language: "en",
          password,
        }),
        headers
      }
    );
    const newUser = JSON.parse(createUserResponse).attributes;
    const createServerResponse = await cloudscraper.post(
      `${domain}/api/application/servers`, {
        body: JSON.stringify({
          name: username,
          description: "Server dibuat via API Buy Panel",
          user: newUser.id,
          egg: 15,
          docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
          startup: "npm start",
          environment: {
            INST: "npm",
            USER_UPLOAD: "0",
            AUTO_UPDATE: "0",
            CMD_RUN: "npm start",
            JS_FILE: "index.js",
          },
          limits: {
            memory: memo,
            swap: 0,
            disk,
            io: 500,
            cpu,
          },
          feature_limits: {
            databases: 5,
            backups: 5,
            allocations: 5,
          },
          deploy: {
            locations: [1],
            dedicated_ip: false,
            port_range: [],
          },
        }),
        headers
      }
    );
    const newServer = JSON.parse(createServerResponse).attributes;
    await User.findByIdAndUpdate(user._id, {
      $inc: {
        saldo: -modifiedHarga
      },
    });
    await tambahHistoryOrder(user._id, {
      id: reff_id,
      reff_id,
      layanan: `Panel ${paket}`,
      code: paket.toUpperCase(),
      target: username,
      price: modifiedHarga.toString(),
      status: "Sukses",
      created_at: new Date(),
    });
    return res.status(201).json({
      success: true,
      message: "Server berhasil dibuat",
      data: {
        id: reff_id,
        reff_id,
        layanan: `Panel ${paket}`,
        code: paket.toUpperCase(),
        target: username,
        price: modifiedHarga.toString(),
        status: "Sukses",
        created_at: new Date(),
        user: {
          id: newUser.id,
          username: newUser.username,
          email,
          password,
        },
        server: {
          id: newServer.id,
          name: newServer.name,
          memory: memo,
          disk,
          cpu,
        },
      },
    });
  } catch (error) {
    await tambahHistoryOrder(user._id, {
      id: generateReffId(),
      layanan: `Panel ${paket}`,
      code: paket.toUpperCase(),
      target: username,
      price: modifiedHarga.toString(),
      status: "Gagal - Internal server error",
      created_at: new Date(),
    });
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan saat membuat server",
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
