import React from "react";
import { Badge } from "@/components/ui/badge";

type LeadRow = {
  id: string;
  name: string;
  company?: string;
  value: number;
  status: string;
  responsible?: string;
  updatedAt?: string | number | Date;
};

type LeadsTableProps = {
  rows: LeadRow[];
};

export function LeadsTable({ rows }: LeadsTableProps) {
  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-accent/40 text-foreground/80">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Nome</th>
            <th className="text-left px-4 py-2 font-medium">Valor</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-left px-4 py-2 font-medium">Responsável</th>
            <th className="text-left px-4 py-2 font-medium">Atualizado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border/40 hover:bg-sidebar-accent">
              <td className="px-4 py-2">
                <div className="font-medium text-foreground">{r.name}</div>
                {r.company && <div className="text-xs text-muted-foreground">{r.company}</div>}
              </td>
              <td className="px-4 py-2 font-semibold text-primary">R$ {Number(r.value || 0).toLocaleString('pt-BR')}</td>
              <td className="px-4 py-2"><Badge variant="outline" className="text-xs">{r.status}</Badge></td>
              <td className="px-4 py-2 text-muted-foreground text-xs">{r.responsible || "—"}</td>
              <td className="px-4 py-2 text-muted-foreground text-xs">{formatDate(r.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(d?: string | number | Date) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return String(d);
  }
}


