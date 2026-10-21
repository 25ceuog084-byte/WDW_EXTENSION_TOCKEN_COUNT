// Runs inside the claude.ai page. After every reply, Claude's server adds a hidden
// "message_limit" line with your usage. This file finds it and passes it to content.js.
(() => {
  const originalFetch = window.fetch;

  window.fetch = function (input, init) {
    const promise = originalFetch.apply(this, arguments); // the page gets its answer untouched
    const url = typeof input === "string" ? input : input.url || String(input);
    const method = (init && init.method) || input.method || "GET";
    if (method === "POST" && /\/chat_conversations\/[^/]+\/(retry_)?completion/.test(url)) {
      promise.then(readReply, () => {});
    }
    return promise;
  };

  async function readReply(res) {
    try {
      if (!res.ok || !res.body) return;
      const reader = res.clone().body.getReader(); // read a COPY, so the page is not affected
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:") || !line.includes("message_limit")) continue;
        const data = JSON.parse(line.slice(5));
        if (data.type === "message_limit") {
          window.postMessage({ source: "usage-meter", messageLimit: data.message_limit }, location.origin);
        }
      }
    } catch (e) {
      console.log("[usage-meter] could not read reply", e);
    }
  }
})();
