import { exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";

describe("Cloudflare Access feature-off RPC behavior", () => {
  it("keeps an unconfigured deployment on its ordinary authentication path", async () => {
    const response = await exports.default.fetch(new Request("https://workshop.invalid/api", {
      headers: { Upgrade: "websocket" },
    }));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new TypeError("Expected a WebSocket response.");
    socket.accept();

    using publicApi: RpcStub<PublicApi> = newWebSocketRpcSession<PublicApi>(socket);
    await expect(publicApi.getServerConfig()).resolves.toMatchObject({ accessAuthEnabled: false });

    const username = `ordinary${crypto.randomUUID().replaceAll("-", "")}`;
    await expect(publicApi.createAccount(username, username, new Uint8Array([1, 2, 3])))
      .resolves.toMatch(new RegExp(`^${username}:`));
  });
});
