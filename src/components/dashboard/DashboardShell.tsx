import React from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Upload, Search } from "lucide-react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

type DashboardShellProps = {
  title?: string;
  children: React.ReactNode;
  onImportClick?: () => void;
};

export function DashboardShell({ title = "Dashboard", children, onImportClick }: DashboardShellProps) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="space-y-6">{children}</div>
    </div>
  );
}


