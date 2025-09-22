import React, { useEffect, useRef } from "react"

type Star = { x: number; y: number; z: number; baseAlpha: number; };

type StarfieldProps = {
  starCount?: number
  speed?: number
  twinkle?: boolean
  className?: string
}

export default function StarfieldBackground({ starCount = 260, speed = 0.12, twinkle = true, className }: StarfieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const starsRef = useRef<Star[]>([])
  const rafRef = useRef<number | null>(null)
  const mouseRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d', { alpha: true })!

    let width = 0
    let height = 0
    let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))

    function resize() {
      const { innerWidth, innerHeight } = window
      width = innerWidth
      height = innerHeight
      dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1))
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function seed() {
      const count = starCount
      const arr: Star[] = []
      for (let i = 0; i < count; i++) {
        arr.push({
          x: Math.random() * width,
          y: Math.random() * height,
          z: 0.25 + Math.random() * 0.75, // depth 0.25..1
          baseAlpha: 0.25 + Math.random() * 0.75,
        })
      }
      starsRef.current = arr
    }

    let lastTs = 0

    function render(ts: number) {
      const dt = Math.min(32, ts - lastTs) || 16
      lastTs = ts

      // Clear to transparent (we draw only stars)
      ctx.clearRect(0, 0, width, height)

      const isDark = document.documentElement.classList.contains('dark')
      const starColor = isDark ? '255,255,255' : '0,0,0'

      const mouse = mouseRef.current
      const parallaxX = mouse ? ((mouse.x - width / 2) / width) * 8 : 0
      const parallaxY = mouse ? ((mouse.y - height / 2) / height) * 8 : 0

      for (const s of starsRef.current) {
        // Move downward; closer stars move faster
        s.y += (speed + s.z * speed) * (dt / 16)
        s.x += parallaxX * s.z * 0.1
        if (s.y > height + 2) {
          s.y = -2
          s.x = Math.random() * width
          s.z = 0.25 + Math.random() * 0.75
        }

        const size = 0.6 + s.z * 1.6
        let alpha = s.baseAlpha * (isDark ? 0.9 : 0.6)
        if (twinkle) {
          alpha *= 0.8 + Math.sin((ts / 800) + s.x * 0.01 + s.y * 0.01) * 0.2
        }

        ctx.fillStyle = `rgba(${starColor},${alpha.toFixed(3)})`
        ctx.beginPath()
        ctx.arc(s.x, s.y, size, 0, Math.PI * 2)
        ctx.fill()
      }

      rafRef.current = requestAnimationFrame(render)
    }

    function onMouseMove(e: MouseEvent) {
      mouseRef.current = { x: e.clientX, y: e.clientY }
    }
    function onMouseLeave() {
      mouseRef.current = null
    }

    resize()
    seed()
    rafRef.current = requestAnimationFrame(render)
    const onResize = () => { resize(); seed() }
    window.addEventListener('resize', onResize)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseleave', onMouseLeave)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseleave', onMouseLeave)
      window.removeEventListener('resize', onResize)
    }
  }, [starCount, speed, twinkle])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={
        [
          "pointer-events-none fixed inset-0 -z-10 opacity-80 transition-opacity duration-500",
          "[mask-image:radial-gradient(80%_60%_at_50%_40%,white_60%,transparent_100%)]",
          className || ""
        ].join(" ")
      }
    />
  )
}


