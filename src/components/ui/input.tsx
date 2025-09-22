import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-foreground/50 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.4)] focus:shadow-[inset_0_0_0_2px_hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
