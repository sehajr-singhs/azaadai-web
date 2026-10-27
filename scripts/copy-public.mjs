// The CLI and the persona are served from the site so installers can fetch them.
import { copyFileSync } from "node:fs";
copyFileSync("cli/azaad.py", "public/azaad.py");
copyFileSync("prompts/azaad.md", "public/azaad.md");
