import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("invalid key is recoverable without changing the working fixture key", async ({ app, screen }) => {
 await app.open("/");
 await screen.getByRole("button", "Steam API key").click();
 await screen.getByLabel("Steam API key").fill("invalid");
 await screen.getByRole("button", "Use key").click();
 await expect(screen.getByText("Enter the 32-character key from Steam's API key page.")).toBeVisible();
 await screen.getByRole("button", "Cancel", {exact:true}).click();
 await expect(screen.getByRole("button", "Analyze", {exact:true})).toBeVisible();
});

test("scan, inspect results and exports through real local provider fixtures", async ({ app, screen }) => {
 await app.open("/");
 await screen.getByLabel("Requests/min").fill("0");
 await screen.getByLabel("Target", {exact:true}).fill("76561197960265729");
 await screen.getByRole("button", "Analyze", {exact:true}).click();
 await expect(screen.getByRole("heading", "Player 29", {exact:true})).toBeVisible();
 await expect(screen.getByRole("heading", "Ranked friends")).toBeVisible();
 await screen.getByRole("navigation", "Report views").getByRole("button", "Exports", {exact:true}).click();
 await expect(screen.getByRole("link", /scan\.json/)).toBeVisible();
 await screen.getByRole("navigation", "Workspace").getByRole("button", "Scan", {exact:true}).click();
 await expect(screen.getByLabel("Target", {exact:true})).toBeVisible();
});
