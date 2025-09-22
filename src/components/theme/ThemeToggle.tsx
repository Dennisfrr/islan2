import React from "react";
import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";

// If you already have a theme provider, wire it here. Fallback toggles a data-theme attr.
export function ThemeToggle() {
  const [dark, setDark] = React.useState<boolean>(true);

  React.useEffect(() => {
    const root = document.documentElement;
    if (dark) root.classList.add("dark"); else root.classList.remove("dark");
  }, [dark]);

  return (
    <Button variant="outline" size="icon" onClick={() => setDark(v => !v)} aria-label="Alternar tema">
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}


