// A stand-in for the three store APIs, for the preview end-to-end run (not a
// unit test). Serves the exact request/response shapes the bridge uses:
//   POST /token                                  Google OAuth (service account + refresh)
//   GET  /play/applications/:pkg/reviews         Play list        POST …/reviews/:id:reply
//   GET  /apple/v1/apps/:id/customerReviews      Apple list       POST /apple/v1/customerReviewResponses
//   GET  /google/v4/accounts/:a/locations/:l/reviews  GBP list    PUT  …/reviews/:id/reply
// Control: GET /_state, POST /_edit {store,id,body,rating}, POST /_add {store, review}
// Run: node tests/reviews/mockstore.mjs [port]  (default 4000)

import http from "node:http";

const port = Number(process.argv[2] || process.env.PORT || 4000);

const state = {
  play: [
    { reviewId: "gp:AOqpTOH.one", authorName: "John Doe", comments: [{ userComment: { text: "Great app\tBooked in two minutes, loved it.", lastModified: { seconds: String(Math.floor(Date.now() / 1000) - 3600), nanos: 0 }, starRating: 5, reviewerLanguage: "en", device: "trltecan", androidOsVersion: 34, appVersionName: "3.4.1", deviceMetadata: { productName: "Pixel 8" } } }] },
    { reviewId: "gp:AOqpTOH.two", authorName: "Asha K", comments: [{ userComment: { text: "Refund still pending after 10 days. Nobody answers.", lastModified: { seconds: String(Math.floor(Date.now() / 1000) - 600), nanos: 0 }, starRating: 1, reviewerLanguage: "en", appVersionName: "3.4.1" } }] },
  ],
  apple: [
    { type: "customerReviews", id: "a1b2c3d4-0000-0000-0000-000000000001", attributes: { rating: 2, title: "Crashes on checkout", body: "App closes when I tap pay. iPhone 15.", reviewerNickname: "flyer99", createdDate: new Date(Date.now() - 7200e3).toISOString(), territory: "USA" }, relationships: { response: { data: null } } },
  ],
  google: [
    { name: "accounts/1/locations/2/reviews/AbFvOq1", reviewId: "AbFvOq1", reviewer: { displayName: "Priya S", isAnonymous: false }, starRating: "FOUR", comment: "Quick refund, thanks team.", createTime: new Date(Date.now() - 86400e3).toISOString(), updateTime: new Date(Date.now() - 3600e3).toISOString() },
    { name: "accounts/1/locations/2/reviews/AbFvOq2", reviewId: "AbFvOq2", reviewer: { isAnonymous: true }, starRating: "ONE", createTime: new Date(Date.now() - 1800e3).toISOString(), updateTime: new Date(Date.now() - 1800e3).toISOString() },
  ],
  replies: [],
  requests: [],
};

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://x`);
  const raw = await readBody(req);
  const body = raw && raw.startsWith("{") ? JSON.parse(raw) : raw;
  state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization ? "yes" : "no" });
  const p = url.pathname;
  let m;

  if (p === "/token") return send(res, 200, { access_token: "mock-token", expires_in: 3600, token_type: "Bearer" });
  // Google routes expect the token minted by /token; Apple sends its own ES256 JWT as the bearer.
  const auth = req.headers.authorization || "";
  const okAuth = p.startsWith("/apple/") ? /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth) : auth === "Bearer mock-token";
  if (!okAuth && !p.startsWith("/_")) return send(res, 401, { error: "no bearer" });

  if ((m = /^\/play\/applications\/([^/]+)\/reviews$/.exec(p)) && req.method === "GET") return send(res, 200, { reviews: state.play });
  if ((m = /^\/play\/applications\/([^/]+)\/reviews\/(.+):reply$/.exec(p)) && req.method === "POST") {
    const id = decodeURIComponent(m[2]);
    const review = state.play.find((r) => r.reviewId === id);
    if (!review) return send(res, 404, { error: { message: "review not found" } });
    if ([...body.replyText].length > 350) return send(res, 400, { error: { message: "replyText is too long" } });
    review.comments = [review.comments[0], { developerComment: { text: body.replyText, lastModified: { seconds: String(Math.floor(Date.now() / 1000)) } } }];
    state.replies.push({ store: "play", id, text: body.replyText });
    return send(res, 200, { result: { replyText: body.replyText, lastEdited: { seconds: String(Math.floor(Date.now() / 1000)) } } });
  }

  if ((m = /^\/apple\/v1\/apps\/([^/]+)\/customerReviews$/.exec(p)) && req.method === "GET") return send(res, 200, { data: state.apple, links: { self: req.url }, meta: { paging: { total: state.apple.length, limit: 200 } } });
  if (p === "/apple/v1/customerReviewResponses" && req.method === "POST") {
    const id = body?.data?.relationships?.review?.data?.id;
    const review = state.apple.find((r) => r.id === id);
    if (!review) return send(res, 404, { errors: [{ status: "404", title: "review not found" }] });
    review.relationships = { response: { data: { type: "customerReviewResponses", id: `resp-${id}` } } };
    state.replies.push({ store: "apple", id, text: body.data.attributes.responseBody });
    return send(res, 201, { data: { type: "customerReviewResponses", id: `resp-${id}`, attributes: { responseBody: body.data.attributes.responseBody, state: "PENDING_PUBLISH" } } });
  }

  if ((m = /^\/google\/v4\/accounts\/([^/]+)\/locations\/([^/]+)\/reviews$/.exec(p)) && req.method === "GET") return send(res, 200, { reviews: state.google, averageRating: 2.5, totalReviewCount: state.google.length });
  if ((m = /^\/google\/v4\/accounts\/([^/]+)\/locations\/([^/]+)\/reviews\/([^/]+)\/reply$/.exec(p)) && req.method === "PUT") {
    const id = decodeURIComponent(m[3]);
    const review = state.google.find((r) => r.reviewId === id);
    if (!review) return send(res, 404, { error: { message: "review not found" } });
    review.reviewReply = { comment: body.comment, updateTime: new Date().toISOString(), reviewReplyState: "PENDING" };
    state.replies.push({ store: "google", id, text: body.comment });
    return send(res, 200, review.reviewReply);
  }

  if (p === "/_state") return send(res, 200, state);
  if (p === "/_edit" && req.method === "POST") {
    const { store, id, body: text, rating } = body;
    const now = new Date();
    if (store === "play") { const r = state.play.find((x) => x.reviewId === id); r.comments[0].userComment.text = text; if (rating) r.comments[0].userComment.starRating = rating; r.comments[0].userComment.lastModified = { seconds: String(Math.floor(now / 1000)), nanos: 0 }; }
    if (store === "apple") { const r = state.apple.find((x) => x.id === id); r.attributes.body = text; if (rating) r.attributes.rating = rating; }
    if (store === "google") { const r = state.google.find((x) => x.reviewId === id); r.comment = text; if (rating) r.starRating = rating; r.updateTime = now.toISOString(); }
    return send(res, 200, { ok: true });
  }
  if (p === "/_add" && req.method === "POST") { state[body.store].unshift(body.review); return send(res, 200, { ok: true }); }
  return send(res, 404, { error: `no route ${req.method} ${p}` });
}).listen(port, () => console.log(`[mockstore] listening on :${port}`));
