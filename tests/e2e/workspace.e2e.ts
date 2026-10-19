import { readFile } from "node:fs/promises";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("invalid key is recoverable without changing the working fixture key", async ({ app, screen, browser }) => {
 await app.open("/");
 await expect(screen.getByText("Key ready", {exact:true})).toBeVisible();
 await screen.getByRole("button", "Steam API key").click();
 await screen.getByRole("textbox", { name: "Steam API key", exact: true }).fill("invalid");
 await screen.getByRole("button", "Use key").click();
 await expect(screen.getByText("Enter the 32-character key from Steam's API key page.")).toBeVisible();
 await screen.getByRole("button", "Cancel", {exact:true}).click();
 await expect(screen.getByRole("button", "Analyze", {exact:true})).toBeVisible();
});

test("scan, inspect results and exports through real local provider fixtures", async ({ app, screen, browser }) => {
 await app.open("/");
 await expect(screen.getByText("Key ready", {exact:true})).toBeVisible();
 await screen.getByLabel("Requests/min").fill("0");
 await screen.getByLabel("Target", {exact:true}).fill("76561197960265729");
 await screen.getByRole("button", "Analyze", {exact:true}).click();
 await expect(screen.getByRole("heading", "Player 29", {exact:true})).toBeVisible();
 await expect(screen.getByRole("heading", "Ranked friends")).toBeVisible();
 await screen.getByRole("navigation", "Report views").getByRole("button", "Exports", {exact:true}).click();
 const link = screen.getByRole("link", /scan\.json/);
 await expect(link).toBeVisible();
 const href = await link.getAttribute("href");
 const expectedId = new URL(href!, "http://127.0.0.1:4178").searchParams.get("id");
 const download = await browser.waitForDownload(() => link.click());
 const scan = JSON.parse(await readFile(download.absolutePath, "utf8"));
 expect(scan.id).toBe(expectedId);
 expect(scan.seed).toBe("76561197960265729");
 expect(scan.version).toBe(2);
 expect(scan.players.some((player: {id:string;name:string}) => player.id === scan.seed && player.name === "Player 29")).toBe(true);
 await screen.getByRole("navigation", "Workspace").getByRole("button", "Scan", {exact:true}).click();
 await expect(screen.getByLabel("Target", {exact:true})).toBeVisible();
});
