import React from "react"
import { Card } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts"

type MonthPoint = { month: string; value: number }

type OverviewBarChartProps = {
	points: MonthPoint[]
	title?: string
	className?: string
}

export function OverviewBarChart({ points, title = "", className }: OverviewBarChartProps) {
	return (
		<Card className={`p-4 ${className || ""}`}>
			{title ? <div className="text-sm font-medium text-foreground mb-2">{title}</div> : null}
			<ChartContainer config={{ value: { label: "Valor", color: "hsl(var(--primary))" } }} className="w-full h-60">
				<BarChart data={points}>
					<CartesianGrid vertical={false} strokeDasharray="3 3" />
					<XAxis dataKey="month" />
					<YAxis width={40} allowDecimals={true} />
					<Bar dataKey="value" fill="var(--color-value)" radius={[6,6,0,0]} />
					<ChartTooltip cursor={true} content={<ChartTooltipContent />} />
				</BarChart>
			</ChartContainer>
		</Card>
	)
}

export default OverviewBarChart


