import React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type QuickActionCardProps = {
  icon: React.ReactNode;
  title: string;
  description?: string;
  actionLabel?: string;
  onClick?: () => void;
};

export function QuickActionCard({ icon, title, description, actionLabel = "Abrir", onClick }: QuickActionCardProps) {
  return (
    <Card className="card-glass card-spotlight card-tilt card-gradient-border bg-card/60 border-border/40 hover:shadow-card transition-all">
      <CardContent className="p-4 flex items-start gap-3">
        <div className="h-9 w-9 rounded-md bg-secondary flex items-center justify-center text-foreground/90">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{title}</div>
          {description && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{description}</div>}
          <Button size="sm" className="mt-3" onClick={onClick}>{actionLabel}</Button>
        </div>
      </CardContent>
    </Card>
  );
}


