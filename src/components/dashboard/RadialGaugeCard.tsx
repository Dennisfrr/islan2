import React from "react"
import { Card } from "@/components/ui/card"

type RadialGaugeCardProps = {
	label: string
	amountLabel?: string
	amount?: React.ReactNode
	percent: number // 0..100
	className?: string
}

export function RadialGaugeCard({ label, amountLabel = "Amount Owed", amount, percent, className }: RadialGaugeCardProps) {
	const clamped = Math.max(0, Math.min(100, percent))
	return (
		<Card className={`relative overflow-hidden p-0 ${className || ""}`}>
			<div className="p-5">
				<div className="text-xs text-muted-foreground">{label}</div>
			</div>
			<div className="px-5 pb-5">
				<div className="relative h-44">
					<svg viewBox="0 0 100 60" className="w-full h-full">
						<defs>
							<linearGradient id="rg" x1="0%" y1="0%" x2="100%" y2="0%">
								<stop offset="0%" stopColor="hsl(var(--primary))" />
								<stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.7" />
							</linearGradient>
						</defs>
						<path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="url(#rg)" strokeOpacity="0.25" strokeWidth="10" strokeLinecap="round" />
						<path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="url(#rg)" strokeWidth="10" strokeLinecap="round" strokeDasharray="125.6" strokeDashoffset={`${125.6 * (1 - clamped / 100)}`} />
					</svg>
					<div className="absolute inset-0 flex items-center justify-center">
						<div className="text-center">
							<div className="text-3xl font-bold text-foreground">{clamped}%</div>
							{amount ? (
								<div className="mt-3 text-left">
									<div className="text-[11px] text-foreground/80">{amountLabel}</div>
									<div className="text-lg font-semibold text-primary">{amount}</div>
								</div>
							) : null}
						</div>
					</div>
				</div>
			</div>
		</Card>
	)
}

export default RadialGaugeCard


