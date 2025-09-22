import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-ring/50 focus:ring-offset-0",
  {
    variants: {
      variant: {
        default:
          "border-border/60 bg-muted text-foreground/80 hover:bg-muted",
        secondary:
          "border-border/60 bg-accent text-foreground/80 hover:bg-accent",
        destructive:
          "border-border/60 bg-destructive/10 text-destructive hover:bg-destructive/15",
        outline: "text-foreground/80 border-border/60",
        whatsapp: "border-border/60 bg-background text-foreground/80",
        instagram: "border-border/60 bg-background text-foreground/80",
        messenger: "border-border/60 bg-background text-foreground/80",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
