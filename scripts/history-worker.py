"""Private browser transport. The TypeScript provider owns decoding and pagination."""
import asyncio
import base64
import json
import logging
import os
import re
import sys

from pydoll import Chrome, ChromiumOptions

USER_AGENT = "OpenAI File Downloader, XaiImageApiFetch/1.0"
logging.basicConfig(level=logging.CRITICAL)
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def emit(payload):
    print(json.dumps(payload, ensure_ascii=True), flush=True)


async def evaluate(tab, script):
    response = await tab.execute_script(script, return_by_value=True, await_promise=True)
    if "exceptionDetails" in response["result"]:
        raise RuntimeError("The browser is navigating or its request failed.")
    return response["result"]["result"]["value"]


async def serve():
    browser_path, profile_path, account, origin, sandbox = sys.argv[1:]
    if not re.fullmatch(r"[0-9]{17}", account) or not 76561197960265728 < int(account) <= 76561202255233023:
        raise ValueError("Invalid Steam account.")
    if origin != "https://steamhistory.net" and not re.fullmatch(r"http://127\.0\.0\.1:\d+", origin):
        raise ValueError("Only History or a loopback test provider is accepted.")
    # Frozen Python adjusts native library lookup. Chromium must use its own libraries.
    if getattr(sys, "frozen", False):
        if sys.platform == "win32":
            import ctypes
            ctypes.windll.kernel32.SetDllDirectoryW(None)
        elif sys.platform != "darwin":
            original = os.environ.pop("LD_LIBRARY_PATH_ORIG", None)
            if original is None:
                os.environ.pop("LD_LIBRARY_PATH", None)
            else:
                os.environ["LD_LIBRARY_PATH"] = original
    options = ChromiumOptions()
    options.binary_location = browser_path
    options.start_timeout = 20
    # Windowless Chromium never steals focus or opens a verification popup.
    for argument in ["--headless=new", "--window-size=900,700",
                     f"--user-agent={USER_AGENT}", f"--user-data-dir={profile_path}"]:
        options.add_argument(argument)
    # The distributed default keeps Chromium's sandbox. CI may explicitly opt out.
    if sandbox == "disabled":
        options.add_argument("--no-sandbox")
    async with Chrome(options=options) as browser:
        tab = await browser.start()
        async def navigate():
            async with tab.expect_cloudflare_turnstile(time_to_wait_captcha=15):
                await tab.go_to(f"{origin}/id/{account}", timeout=30)
        await asyncio.wait_for(navigate(), 50)
        # Cloudflare may replace the execution context while redirecting.
        deadline = asyncio.get_running_loop().time() + 20
        while True:
            try:
                state = await evaluate(tab, "({title:document.title,origin:location.origin,status:performance.getEntriesByType('navigation')[0]?.responseStatus})")
                if state["title"] != "Just a moment..." and state["origin"] == origin:
                    if state.get("status", 200) >= 400:
                        raise ValueError("History did not open the requested profile.")
                    break
            except RuntimeError:
                pass
            if asyncio.get_running_loop().time() >= deadline:
                raise ValueError("History verification did not finish. Retry or import a saved capture.")
            await asyncio.sleep(0.5)
        emit({"id": 0, "ready": True})
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return
            command = json.loads(line)
            if command.get("command") == "close":
                return
            path = command.get("path", "")
            allowed = f"/id/{account}/"
            if not path.startswith(allowed) or not re.fullmatch(r"(?:__data\.json|history\?[a-zA-Z0-9=&%-]+)", path[len(allowed):]):
                raise ValueError("Unsupported History request.")
            try:
                script = """(async()=>{
                  const response=await fetch(PATH,{credentials:'include',signal:AbortSignal.timeout(20000)});
                  const reader=response.body.getReader(); const chunks=[]; let size=0;
                  while(true){
                    const {done,value}=await reader.read(); if(done) break;
                    size+=value.length;
                    if(size>2097152){ await reader.cancel(); throw new Error('Response exceeds the capture limit'); }
                    chunks.push(value);
                  }
                  const bytes=new Uint8Array(size); let position=0;
                  for(const chunk of chunks){ bytes.set(chunk,position); position+=chunk.length; }
                  let binary='';
                  for(let offset=0;offset<bytes.length;offset+=8192) binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
                  return {status:response.status,contents:btoa(binary)};
                })()""".replace("PATH", json.dumps(path))
                response = await asyncio.wait_for(evaluate(tab, script), 22)
                response["contents"] = base64.b64decode(response["contents"]).decode("utf-8")
                emit({"id": command["id"], **response})
            except (RuntimeError, asyncio.TimeoutError, UnicodeDecodeError):
                emit({"id": command["id"], "error": "History's response could not be read. Retry the capture."})


if __name__ == "__main__":
    try:
        asyncio.run(serve())
    except Exception as error:
        # Browser paths, cookies, challenge URLs and private page content stay out of IPC.
        # The exception class gives support a safe failure code without exposing the provider response.
        emit({"id": 0, "error": f"History's browser could not load the profile ({type(error).__name__}). Retry or import a saved capture."})
        sys.exit(1)
