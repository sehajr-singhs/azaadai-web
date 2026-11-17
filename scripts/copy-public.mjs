// The CLI and the persona are served from the site so installers can fetch them.
import { copyFileSync } from "node:fs";
copyFileSync("cli/azaad.py", "public/azaad.py");
copyFileSync("prompts/azaad.md", "public/azaad.md");
// The gateway re-reads both prompts from the live site, so editing them on GitHub changes the model within ~10 minutes.
copyFileSync("prompts/council.md", "public/council.md");
