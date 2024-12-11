import {
  getOrderDetails,
  helperCheckCoupon,
  helperCreateOrder,
  helperHandleWebhook,
  helperSetNewTest,
  helperVerifyPayment,
} from "./helper";

const checkCoupon = async (context, req, res) => {
  try {
    const discount_percentage = await helperCheckCoupon(context, req, res);

    return res.json({
      success: discount_percentage !== 0,
      data: discount_percentage,
      details: await getOrderDetails(context, discount_percentage),
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
};

const createOrder = async (context, req, res) => {
  try {
    const discount_percentage = await helperCheckCoupon(context, req, res);
    const coupon_code = req.body.coupon_code || null;
    const orderDetail = getOrderDetails(context, discount_percentage);

    // Handle 100% discount case
    if (discount_percentage === 100) {
      // Generate free order metadata
      const freeOrderMeta = {
        razorpay_details: {
          order_id: `FREE-${Date.now()}`,
          payment_id: `FREE-${Date.now()}`,
          razorpay_signature: "FREE-ORDER",
        },
        status: "completed",
        test_id: null,
        order_details: {
          user_id: req.accountability.user,
          name: orderDetail.name,
          retailAmount: orderDetail.retailAmount,
          discountPercentage: 100,
          discountAmount: orderDetail.retailAmount,
          taxPercentage: 0,
          taxAmount: 0,
          totalPayableAmount: 0,
          coupon_code: coupon_code,
        },
      };

      let { database } = context;
      const [paymentId] = await database("payments").insert({
        user_id: req.accountability.user,
        meta: JSON.stringify(freeOrderMeta),
      });

      // Create test entry for free order
      const testId = await helperSetNewTest(context, {
        accountability: { user: req.accountability.user },
        body: {
          order_id: freeOrderMeta.razorpay_details.order_id,
          payment_id: freeOrderMeta.razorpay_details.payment_id,
          razorpay_signature: freeOrderMeta.razorpay_details.razorpay_signature,
        },
      });
      return res.json({
        success: true,
        message: "Free order created successfully",
        orderId: testId,
        fullDiscount: true,
      });
    }
    req.body.discount_percentage = discount_percentage;
    req.body.coupon_code = coupon_code;
    const order = await helperCreateOrder(
      context,
      req,
      orderDetail.totalAmount
    );

    return res.json({
      success: true,
      message: "Order created successfully",
      orderId: order,
      fullDiscount: false,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
};

const verifyPayment = async (context, req, res) => {
  try {
    const { order_id, payment_id, signature } = req.body;

    // Skip verification for free orders
    if (order_id.startsWith("FREE-")) {
      return res.json({
        success: true,
        message: "Free order verified successfully",
      });
    }

    const { isValidSignature, payment, oldStatus } = await helperVerifyPayment(
      context,
      req,
      res
    );
    if (!isValidSignature) {
      throw new Error("Invalid signature");
    }
    if (payment.status !== "captured") {
      throw new Error("Payment not captured");
    }

    console.log("time before verify", Date.now())
    // Create test entry only after successful verification
    // setTimeout(async () => {
    //   console.log("old status: ", oldStatus)
    //   if (!oldStatus) {
    //     console.log("time verify", Date.now())
    //     await helperSetNewTest(context, req);
    //   }
    // }, 5000);

    if (!oldStatus) {
      console.log("time verify", Date.now())
      await helperSetNewTest(context, req);
    }

    // if (!oldStatus) {
    //   await helperSetNewTest(context, req);
    // }

    res.json({
      success: true,
      message: "Payment has been verified and captured",
      paymentDetails: payment,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Bad Request",
      error: error.message,
    });
  }
};

const handleWebhook = async (context, req, res) => {
  try {
    const result = await helperHandleWebhook(context, req);
    return res.json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
};

const getDetails = async (context, req, res) => {
  return res.json({ data: getOrderDetails(context), success: true });
};
export { checkCoupon, createOrder, verifyPayment, getDetails, handleWebhook };
