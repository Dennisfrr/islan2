import { useMemo, useRef, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Download, Upload } from "lucide-react"
import { useLeads } from "@/hooks/useLeads"
import { useToast } from "@/hooks/use-toast"
import { Skeleton } from "@/components/ui/skeleton"

function toCsv(rows: any[]) {
  if (!rows.length) return ""
  const headers = Object.keys(rows[0])
  const escape = (v: any) => {
    if (v === null || v === undefined) return ""
    const s = typeof v === "string" ? v : JSON.stringify(v)
    return '"' + s.replace(/"/g, '""') + '"'
  }
  const lines = [headers.join(",")]
  for (const row of rows) {
    lines.push(headers.map((h) => escape((row as any)[h])).join(","))
  }
  return lines.join("\n")
}

async function readCsv(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const text = await file.text()
  const [headerLine, ...dataLines] = text.split(/\r?\n/).filter(Boolean)
  const headers = headerLine.split(",").map((h) => h.replace(/^\"|\"$/g, ""))
  const rows = dataLines.map((line) => {
    const cols = line.split(",").map((c) => c.replace(/^\"|\"$/g, ""))
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => (obj[h] = cols[i] || ""))
    return obj
  })
  return { headers, rows }
}

export function ContactsView() {
  const { leads, createLead, updateLead, deleteLead } = useLeads()
  const { toast } = useToast()
  const [search, setSearch] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)

  const filtered = useMemo(() => {
    const s = search.toLowerCase()
    return leads.filter((l) =>
      [l.name, l.company, l.email || "", l.phone || "", l.source, l.responsible]
        .some((f) => f?.toLowerCase().includes(s))
    )
  }, [leads, search])

  const handleExport = () => {
    const rows = filtered.map((l) => ({
      id: l.id,
      name: l.name,
      company: l.company,
      email: l.email || "",
      phone: l.phone || "",
      value: l.value,
      status: l.status,
      responsible: l.responsible,
      source: l.source,
      tags: (l.tags || []).join("|"),
      notes: l.notes || "",
      created_at: l.created_at,
      updated_at: l.updated_at,
      last_contact: l.last_contact,
    }))
    const csv = toCsv(rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `contacts_${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async (file: File) => {
    try {
      const { rows } = await readCsv(file)
      let created = 0
      let updated = 0

      for (const r of rows) {
        const tags = (r.tags || "").split("|").filter(Boolean)
        const existing = leads.find((l) =>
          (r.email && l.email && l.email.toLowerCase() === r.email.toLowerCase()) ||
          (r.phone && l.phone && l.phone.replace(/\D/g, "") === r.phone.replace(/\D/g, ""))
        )

        const payload = {
          name: r.name || "",
          company: r.company || "",
          email: r.email || undefined,
          phone: r.phone || undefined,
          value: Number(r.value || 0),
          status: (r.status as any) || "new",
          responsible: r.responsible || "",
          source: r.source || "import",
          tags,
          notes: r.notes || undefined,
        }

        if (existing) {
          updateLead({ ...existing, ...payload })
          updated++
        } else {
          createLead(payload as any)
          created++
        }
      }

      toast({ title: "Importação concluída", description: `${created} criados, ${updated} atualizados.` })
    } catch (e: any) {
      toast({ title: "Erro ao importar", description: e.message, variant: "destructive" })
    } finally {
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <div className="flex-1 p-6 overflow-auto">
      <div className="mb-6 flex justify-between items-center gap-3">
        <Input placeholder="Buscar contatos" className="max-w-md" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex items-center gap-2">
          <input ref={inputRef} type="file" accept=".csv" className="hidden" id="contacts-import" onChange={(e) => e.target.files && handleImport(e.target.files[0])} />
          <Button variant="outline" onClick={() => document.getElementById("contacts-import")?.click()}>
            <Upload className="h-4 w-4 mr-2" /> Importar CSV
          </Button>
          <Button variant="outline" onClick={handleExport}>
            <Download className="h-4 w-4 mr-2" /> Exportar CSV
          </Button>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4 space-y-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
                <div className="space-y-2">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-5/6" />
                  <Skeleton className="h-3 w-4/6" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-muted-foreground py-10">Nenhum contato encontrado com o filtro atual.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((lead, index) => (
            <Card key={lead.id} className="transition-transform hover:-translate-y-[1px] hover:shadow-glow">
              <CardContent className="p-4">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <h3 className="font-semibold text-foreground">{lead.name}</h3>
                    <p className="text-sm text-muted-foreground">{lead.company}</p>
                    {lead.email && <p className="text-xs text-muted-foreground">{lead.email}</p>}
                    {lead.phone && <p className="text-xs text-muted-foreground">{lead.phone}</p>}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Valor:</span>
                    <span className="text-sm font-bold text-success">R$ {lead.value.toLocaleString('pt-BR')}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Status:</span>
                    <Badge variant="outline" className="text-xs">
                      {lead.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Responsável:</span>
                    <span className="text-xs text-muted-foreground">{lead.responsible}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Origem:</span>
                    <span className="text-xs text-muted-foreground">{lead.source}</span>
                  </div>
                  {(lead.tags || []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {lead.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
} 