// A portable JSON-schema RPC definition (Rpc.define is an identity helper).
// Keeping it dependency-free also lets OpenCode 1 load the main entrypoint.
export const CacheBellRPC = {
  id: "cachebell",
  methods: {
    collect: {
      input: {
        type: "object",
        properties: {
          sessionIDs: { type: "array", items: { type: "string" } },
        },
        required: ["sessionIDs"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          warnings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                sessionID: { type: "string" },
                title: { type: "string" },
                message: { type: "string" },
                sound: { anyOf: [{ type: "boolean" }, { type: "string" }] },
                notification: { type: "boolean" },
              },
              required: ["sessionID", "title", "message", "sound", "notification"],
              additionalProperties: false,
            },
          },
        },
        required: ["warnings"],
        additionalProperties: false,
      },
    },
  },
  events: {},
};
