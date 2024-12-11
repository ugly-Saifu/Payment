import { getDetails, createOrder, verifyPayment, checkCoupon, handleWebhook } from "./main";
import getPdf from "./getpdf";

export default {
  id: "payment",
  handler: (router, context) => {
    router.get("/", (req, res) => getDetails(context, req, res));
    router.post("/create", (req, res) => createOrder(context, req, res));
    router.post("/verify", (req, res) => verifyPayment(context, req, res));
    router.post("/check-coupon", (req, res) => checkCoupon(context, req, res));
    router.get("/invoice/pdf/:id", (req, res) => getPdf(context, req, res));
    router.post("/webhook", (req, res) => handleWebhook(context, req, res));
  },
};
