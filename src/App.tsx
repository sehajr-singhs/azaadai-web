import { useEffect, useState } from "react";
import { warm } from "./lib/api";
import { loadAccess, loadSettings, saveAccess, saveSettings, type Settings } from "./lib/store";
import { Ask } from "./pages/Ask";
import { Home } from "./pages/Home";

const routeOf = () => location.hash.replace(/^#/, "") || "/";

export default function App() {
  const [route, setRoute] = useState(routeOf);
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [access, setAccessState] = useState(loadAccess);
  const [pending, setPending] = useState("");

  useEffect(() => {
    const on = () => setRoute(routeOf());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // Start a GPU worker while the visitor reads; by the time they ask, it's warm.
  useEffect(() => {
    warm();
  }, []);

  const setSettings = (s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
  };
  const setAccess = (a: { code: string; group: string }) => {
    setAccessState(a);
    saveAccess(a);
  };

  if (route === "/ask") {
    return <Ask route={route} settings={settings} setSettings={setSettings} access={access} onAccess={setAccess} pending={pending} clearPending={() => setPending("")} />;
  }
  return (
    <Home
      route={route}
      access={access}
      onAccess={setAccess}
      onAsk={(q) => {
        setPending(q);
        location.hash = "/ask";
      }}
    />
  );
}
