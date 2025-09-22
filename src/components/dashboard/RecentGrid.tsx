import React from "react";
import { Card, CardContent } from "@/components/ui/card";

type Item = { id: string; title: string; subtitle?: string };

type RecentGridProps = {
  title: string;
  items: Item[];
  onSelect?: (id: string) => void;
};

export function RecentGrid({ title, items, onSelect }: RecentGridProps) {
  return (
    <div>
      <div className="text-sm font-medium text-foreground mb-3">{title}</div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {items.map((it) => (
          <Card key={it.id} className="group border-border/60 hover:shadow-card transition-colors cursor-pointer" onClick={() => onSelect?.(it.id)}>
            <CardContent className="p-3">
              <div className="text-[13px] font-medium truncate group-hover:text-primary">{it.title}</div>
              {it.subtitle && <div className="text-[11px] text-muted-foreground truncate">{it.subtitle}</div>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}


