import Razorpay from "razorpay";
import crypto from "crypto";

const orderAmount = 1000000;
const taxPercentage = 18;

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const getOrderDetails = (context, discountPercentage = 0) => {
  const discountAmount = Math.floor(orderAmount * (discountPercentage / 100));
  const totalPayableAmount = orderAmount - discountAmount;
  const taxAmount = Math.floor(totalPayableAmount * (taxPercentage / 100));
  const retailAmount = totalPayableAmount - taxAmount;

  return {
    name: "Package 1",
    retailWithoutTax: retailAmount,
    retailAmount: orderAmount,
    discountPercentage: discountPercentage,
    discountAmount: discountAmount,
    taxPercentage: taxPercentage,
    taxAmount: taxAmount,
    totalAmount: totalPayableAmount,
    key_id: context.env.RAZORPAY_KEY_ID,
  };
};

// Function to check and return coupon discount percentage
const helperCheckCoupon = async (context, req, res) => {
  try {
    const { coupon_code } = req.body;
    let { database } = context;
    let percentage = 0;

    const coupon = await database("coupons")
      .select("*")
      .where("coupon_code", "=", coupon_code)
      .where("valid", "=", true)
      .limit(1);

    if (coupon.length > 0) {
      percentage = coupon[0].percentage;
    }

    return percentage;
  } catch (error) {
    return 0;
  }
};

const helperCreateOrder = async (context, req, amount) => {
  const user_id = req.accountability.user;
  const key_id = req.body.key_id;

  if (key_id !== context.env.RAZORPAY_KEY_ID) {
    throw new Error("Invalid Key ID");
  }

  if (!amount || amount <= 0) {
    throw new Error("Invalid amount");
  }

  const razorpay = new Razorpay({
    key_id: context.env.RAZORPAY_KEY_ID,
    key_secret: context.env.RAZORPAY_KEY_SECRET,
  });

  const order = await razorpay.orders.create({
    amount: amount,
    currency: "INR",
    payment_capture: 1,
    notes: {
      user_id,
      expected_amount: parseInt(amount, 10)
    },
  });

  const orderDetails = getOrderDetails(
    context,
    req.body.discount_percentage || 0
  );

  const meta = {
    razorpay_details: {
      order_id: order.id,
      payment_id: null,
      razorpay_signature: null,
    },
    status: "pending",
    test_id: null,
    order_created_on: new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "short",
      timeStyle: "short",
    }),
    payment_verified_on: null,
    order_details: {
      user_id,
      name: orderDetails.name,
      retailAmount: orderDetails.retailAmount,
      discountPercentage: orderDetails.discountPercentage,
      discountAmount: orderDetails.discountAmount,
      taxPercentage: orderDetails.taxPercentage,
      taxAmount: orderDetails.taxAmount,
      totalPayableAmount: amount / 100,
      coupon_code: req.body.coupon_code || null,
    },
  };

  // Store order details in database
  let { database } = context;
  await database("payments").insert({
    user_id: user_id,
    meta: JSON.stringify(meta),
  });

  return order;
};


// adding code for refactorinng

const verifyPaymentDetails = async (database, orderId, amount, storedPayment) => {
  if (!storedPayment) {
    throw new Error("Payment record not found");
  }

  // Verify amount matches
  const paymentMeta = JSON.parse(storedPayment.meta);
  const expectedAmount = paymentMeta.order_details.totalPayableAmount * 100;
  
  if (parseInt(amount, 10) !== expectedAmount) {
    throw new Error("Payment amount mismatch");
  }

  return paymentMeta;
};


// New signature verification helper
const verifySignature = (data, signature, secretKey) => {
  const expectedSignature = crypto
    .createHmac("sha256", secretKey)
    .update(data)
    .digest("hex");
  console.log(expectedSignature, signature)
  if (expectedSignature !== signature) {
    throw new Error("Invalid signature");
  }
  return true;
};

const helperVerifyPayment = async (context, req, res) => {
  const { order_id, payment_id, razorpay_signature } = req.body;
  let { database } = context;

  // Fetch the stored payment record using JSON_EXTRACT
  const storedPayment = await database("payments")
    .whereRaw('json_extract(meta, "$.razorpay_details.order_id") = ?', [order_id])
    .first();

  if (!storedPayment) {
    throw new Error("Invalid order");
  }

  const data = `${order_id}|${payment_id}`;

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(data)
    .digest("hex");

  if (expectedSignature !== razorpay_signature) {
    throw new Error("Invalid signature");
  }

  const payment = await razorpay.payments.fetch(payment_id);

  // Compare the fetched amount with the expected amount
  const expectedAmount = JSON.parse(storedPayment.meta).order_details.totalPayableAmount * 100;

  if (parseInt(payment.amount, 10) !== expectedAmount) {
    throw new Error("Payment amount mismatch");
  }
  if (payment.status !== "captured") {
    throw new Error("Payment not captured");
  }

  const paymendetails = await database("payments")
    .where("id", storedPayment.id)
    .first();

  const paymentMeta = JSON.parse(paymendetails.meta);
  console.log("paymentMeta", paymentMeta);
  console.log("status", paymentMeta.status);

  let oldStatus = false;
  // Check both completed status and existing test_id
  if (paymentMeta.status === "completed" || paymentMeta.test_id) {
    oldStatus = true;
  }

  // Update the payment record with payment details only if not completed
  if (!oldStatus) {
    const updatedMeta = {
      ...JSON.parse(storedPayment.meta),
      razorpay_details: {
        order_id,
        payment_id,
        razorpay_signature,
      },
      status: "completed",
      payment_verified_on: new Date().toISOString(),
    };

    await database("payments")
      .where("id", storedPayment.id)
      .update({
        meta: JSON.stringify(updatedMeta),
      });
  }

  return { isValidSignature: true, payment, oldStatus };
};

const helperHandleWebhook = async (context, req) => {
  try {
    const webhookSignature = req.headers["x-razorpay-signature"];
    const webhookBody = JSON.stringify(req.body);

    // Verify webhook signature
    verifySignature(webhookBody, webhookSignature, process.env.RAZORPAY_WEBHOOK_SECRET);

    // Handle only payment.captured events
    if (req.body.event === "payment.captured") {
      const paymentId = req.body.payload.payment.entity.id;
      const orderId = req.body.payload.payment.entity.order_id;
      const amount = req.body.payload.payment.entity.amount;
      
      let { database } = context;

      // Fetch the stored payment record
      const storedPayment = await database("payments")
        .whereRaw('json_extract(meta, "$.razorpay_details.order_id") = ?', [orderId])
        .first();

      // Verify payment details using existing helper
      const paymentMeta = await verifyPaymentDetails(
        database,
        orderId,
        amount,
        storedPayment
      );

      // Check if test is already assigned or payment is completed
      if (paymentMeta.test_id || paymentMeta.status === "completed") {
        console.log("Test already assigned or payment completed, skipping...");
        return { 
          success: true, 
          message: "Test already assigned or payment completed, webhook skipped" 
        };
      }

      // Update payment status and create test
      const updatedMeta = {
        ...paymentMeta,
        status: "completed",
        payment_verified_on: new Date().toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          dateStyle: "short",
          timeStyle: "short",
        }),
      };

      await database("payments")
        .where("id", storedPayment.id)
        .update({
          meta: JSON.stringify(updatedMeta),
        });

      // Create test entry
      await helperSetNewTest(context, {
        accountability: { user: storedPayment.user_id },
        body: {
          order_id: orderId,
          payment_id: paymentId,
          razorpay_signature: webhookSignature,
        },
      });
      
      console.log("webhook processed successfully");
      return { success: true, message: "Webhook processed successfully" };
    }

    return { success: true, message: "Event ignored" };
  } catch (error) {
    console.error("Webhook Error:", error);
    throw error;
  }
};

const helperSetNewTest = async (context, req) => {
  const user_id = req.accountability.user;
  const { order_id, payment_id, razorpay_signature } = req.body;

  let { database } = context;

  const [new_test_id] = await database("test").insert({
    user_id,
  });

  // genrating invoice id and updating it in database

  const currentDate = new Date();
  currentDate.setHours(currentDate.getHours() + 5);
  currentDate.setMinutes(currentDate.getMinutes() + 30);

  const year = currentDate.getFullYear();
  const month = String(currentDate.getMonth() + 1).padStart(2, "0");
  const day = String(currentDate.getDate()).padStart(2, "0");

  const invoiceId = `INV-${year}${month}${day}-${new_test_id}`;
  console.log("invoidId", invoiceId);

  // Fetch the existing payment record
  const paymentRecord = await database("payments")
    .whereRaw('json_extract(meta, "$.razorpay_details.order_id") = ?', [
      order_id,
    ])
    .first();

  if (!paymentRecord) {
    throw new Error("Payment record not found");
  }

  const existingMeta = JSON.parse(paymentRecord.meta);

  // Update the meta object with new test_id and other details
  const updatedMeta = {
    ...existingMeta,
    razorpay_details: {
      ...existingMeta.razorpay_details,
      order_id,
      payment_id,
      razorpay_signature,
    },
    status: "completed",
    test_id: new_test_id,
    invoice_id: invoiceId,
    payment_verified_on: new Date().toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "short",
      timeStyle: "short",
    }),
  };

  // Update payment record with new test_id
  await database("payments")
    .where("id", paymentRecord.id)
    .update({
      meta: JSON.stringify(updatedMeta),
      test_id: new_test_id,
    });

  return new_test_id;
};
export {
  getOrderDetails,
  helperCheckCoupon,
  helperCreateOrder,
  helperSetNewTest,
  helperVerifyPayment,
  helperHandleWebhook
};