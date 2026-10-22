"""Startup transport unit tests; packaged E2E covers the real browser."""
import asyncio
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock, patch


class NoValidTabFound(Exception):
    pass


# The helper is frozen with Pydoll during packaging. Unit tests isolate startup
# ordering without installing or launching Chromium on the test host.
pydoll = types.ModuleType("pydoll")
pydoll.Chrome = object
pydoll.ChromiumOptions = object
exceptions = types.ModuleType("pydoll.exceptions")
exceptions.NoValidTabFound = NoValidTabFound
spec = importlib.util.spec_from_file_location(
    "history_worker", Path(__file__).resolve().parents[1] / "scripts/history-worker.py")
worker = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"pydoll": pydoll, "pydoll.exceptions": exceptions}):
    spec.loader.exec_module(worker)


class StartupTests(unittest.IsolatedAsyncioTestCase):
    async def test_normal_start_keeps_initial_tab(self):
        tab = object()
        browser = types.SimpleNamespace(start=AsyncMock(return_value=tab), new_tab=AsyncMock())
        self.assertIs(await worker.start_tab(browser), tab)
        browser.new_tab.assert_not_awaited()

    async def test_missing_initial_tab_creates_one_in_running_browser(self):
        tab = object()
        browser = types.SimpleNamespace(start=AsyncMock(side_effect=NoValidTabFound), new_tab=AsyncMock(return_value=tab))
        self.assertIs(await worker.start_tab(browser), tab)
        browser.start.assert_awaited_once()
        browser.new_tab.assert_awaited_once_with()

    async def test_other_startup_errors_are_not_hidden(self):
        browser = types.SimpleNamespace(start=AsyncMock(side_effect=RuntimeError("launch failed")), new_tab=AsyncMock())
        with self.assertRaisesRegex(RuntimeError, "launch failed"):
            await worker.start_tab(browser)
        browser.new_tab.assert_not_awaited()

    async def test_recovery_errors_are_not_hidden(self):
        browser = types.SimpleNamespace(start=AsyncMock(side_effect=NoValidTabFound), new_tab=AsyncMock(side_effect=RuntimeError("target failed")))
        with self.assertRaisesRegex(RuntimeError, "target failed"):
            await worker.start_tab(browser)
        browser.new_tab.assert_awaited_once()

    async def test_recovery_has_a_deadline(self):
        async def stalled():
            await asyncio.sleep(10)
        browser = types.SimpleNamespace(start=AsyncMock(side_effect=NoValidTabFound), new_tab=stalled)
        with self.assertRaises(TimeoutError):
            await worker.start_tab(browser)


if __name__ == "__main__":
    unittest.main()
