import React from "react"
import { Card } from "@/components/ui/card"

type MetricCardProps = {
	label: string
	value: React.ReactNode
	subtitle?: string
	change?: { value: number; positive?: boolean }
	iconSlot?: React.ReactNode
	className?: string
}

export function MetricCard({ label, value, subtitle, change, iconSlot, className }: MetricCardProps) {
	return (
		<Card className={`p-4 relative overflow-hidden ${className || ""}`}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-xs text-muted-foreground">{label}</div>
					<div className="mt-1 text-2xl font-semibold text-foreground truncate">{value}</div>
					{subtitle ? (
						<div className="mt-1 text-[11px] text-muted-foreground">{subtitle}</div>
					) : null}
				</div>
				{iconSlot ? (
					<div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
						{iconSlot}
					</div>
				) : null}
			</div>
			{typeof change?.value === "number" ? (
				<div className={`absolute right-3 top-3 text-[11px] px-2 py-0.5 rounded-full border ${change?.positive ? "text-emerald-600 border-emerald-500/30 bg-emerald-500/10" : "text-rose-600 border-rose-500/30 bg-rose-500/10"}`}>
					{change.positive ? "+" : ""}{change.value}%
				</div>
			) : null}
		</Card>
	)
}

export default MetricCard


