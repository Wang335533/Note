import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : null;
const executable = requestedExecutable
  || path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
const args = requestedExecutable ? [] : [projectRoot];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Could not reserve a DevTools port");
  return port;
}

async function waitForTarget(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) return page;
      }
    } catch {
      // DevTools is still starting.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the Electron renderer");
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const exceptions = [];
  let nextId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      exceptions.push(message.params?.exceptionDetails?.text || "Renderer exception");
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  return { socket, send, exceptions };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Renderer evaluation failed");
  }
  return result.result?.value;
}

async function waitFor(send, expression, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await evaluate(send, expression);
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "note-desktop-smoke-"));
const appData = path.join(temporaryRoot, "Roaming");
const localAppData = path.join(temporaryRoot, "Local");
await Promise.all([
  fs.mkdir(appData, { recursive: true }),
  fs.mkdir(localAppData, { recursive: true }),
]);

const port = await reservePort();
const child = spawn(executable, [...args, `--remote-debugging-port=${port}`], {
  cwd: projectRoot,
  env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let processOutput = "";
child.stdout.on("data", (chunk) => { processOutput += chunk.toString(); });
child.stderr.on("data", (chunk) => { processOutput += chunk.toString(); });

let cdp;
try {
  const target = await waitForTarget(port, child);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  const todo = await waitFor(
    cdp.send,
    `(() => {
      const root = document.querySelector("#root");
      const moduleSwitch = document.querySelector(".module-switch");
      if (!root?.textContent || !moduleSwitch) return null;
      return {
        readyState: document.readyState,
        title: document.title,
        text: moduleSwitch.textContent.replace(/\\s+/g, " ").trim(),
        desktopBridge: Boolean(window.noteDesktop),
        script: document.querySelector("script[type=module]")?.getAttribute("src") || "",
      };
    })()`,
    "the Todo workspace",
  );

  if (!todo.desktopBridge || !todo.text.includes("Todo") || !todo.text.includes("Notes")) {
    throw new Error(`Unexpected Todo workspace state: ${JSON.stringify(todo)}`);
  }

  await evaluate(cdp.send, `document.querySelector(".module-switch button:last-child")?.click()`);
  const notes = await waitFor(
    cdp.send,
    `(() => {
      const workspace = document.querySelector(".notes-workspace");
      if (!workspace) return null;
      return { text: workspace.textContent.replace(/\\s+/g, " ").trim().slice(0, 160) };
    })()`,
    "the Notes workspace",
  );

  if (cdp.exceptions.length) throw new Error(`Renderer exceptions: ${cdp.exceptions.join(" | ")}`);
  console.log(JSON.stringify({ ok: true, todo, notes }, null, 2));
} catch (error) {
  if (processOutput.trim()) console.error(processOutput.trim());
  throw error;
} finally {
  if (cdp) {
    try {
      await Promise.race([cdp.send("Browser.close"), delay(500)]);
    } catch {
      // The process may already be closing.
    }
    cdp.socket.close();
  }
  await Promise.race([once(child, "exit"), delay(5_000)]).catch(() => {});
  if (child.exitCode === null) child.kill();
  await delay(250);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}
