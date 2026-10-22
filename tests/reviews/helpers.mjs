import crypto from "node:crypto";

// Replace global fetch for one test; handler(url, init) → { status?, body? }.
export function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body };
    calls.push(call);
    const r = (await handler(call)) ?? {};
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export const json = (call) => (call.body ? JSON.parse(call.body) : null);

export function ecKeyPem() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }), publicKey };
}

export function rsaKeyPem() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }), publicKey };
}

// A recording fake of chatwoot.js publicInbox(). `conversations` preloads the
// list for every contact; otherwise each source_id gets its own list.
export function fakeInbox({ conversations = null } = {}) {
  const calls = [];
  const bySource = new Map();
  let nextId = 100;
  const listFor = (sid) => {
    if (conversations) return conversations;
    if (!bySource.has(sid)) bySource.set(sid, []);
    return bySource.get(sid);
  };
  return {
    calls,
    createContact: async (args) => { calls.push(["createContact", args]); return { source_id: args.sourceId }; },
    updateContact: async (sid, args) => { calls.push(["updateContact", sid, args]); return {}; },
    listConversations: async (sid) => { calls.push(["listConversations", sid]); return listFor(sid); },
    createConversation: async (sid, attrs) => {
      calls.push(["createConversation", sid, attrs]);
      const c = { id: nextId++, messages: [] };
      listFor(sid).push(c);
      return c;
    },
    postMessage: async (sid, id, content) => { calls.push(["postMessage", sid, id, content]); return { id: nextId++, content }; },
  };
}

export const PLAY_RAW = {
  reviewId: "gp:AOqpTOH-abc.def",
  authorName: "John Doe",
  comments: [
    {
      userComment: {
        text: "Great app\tI love using this app!",
        lastModified: { seconds: "1760000000", nanos: 0 },
        starRating: 5,
        reviewerLanguage: "en",
        device: "trltecan",
        androidOsVersion: 21,
        appVersionCode: 12345,
        appVersionName: "1.2.3",
        deviceMetadata: { productName: "E5333 (Xperia™ C4 Dual)", manufacturer: "Sony" },
      },
    },
  ],
};

export const APPLE_RAW = {
  type: "customerReviews",
  id: "00000000-1111-2222-3333-444444444444",
  attributes: { rating: 2, title: "Crashes", body: "Crashes on checkout", reviewerNickname: "flyer99", createdDate: "2026-10-20T10:00:00+00:00", territory: "USA" },
  relationships: { response: { data: null } },
};

export const GOOGLE_RAW = {
  name: "accounts/1/locations/2/reviews/AbFvOq",
  reviewId: "AbFvOq",
  reviewer: { displayName: "Priya S", profilePhotoUrl: "https://lh3.example/p.jpg", isAnonymous: false },
  starRating: "FOUR",
  comment: "Quick refund, thanks",
  createTime: "2026-10-18T08:00:00Z",
  updateTime: "2026-10-19T08:00:00Z",
};
