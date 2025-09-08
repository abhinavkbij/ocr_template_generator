import { useState, useEffect, useRef } from 'react'
import './App.css'

function App() {
    // Image handling
    const [imageUrl, setImageUrl] = useState(null)
    const [imageName, setImageName] = useState('uploaded-image')
    const imageRef = useRef(null) // HTMLImageElement (not in DOM)
    const canvasRef = useRef(null)
    const containerRef = useRef(null)

    // Viewport interaction (zoom/pan)
    const [zoom, setZoom] = useState(1) // 1 = fit-to-canvas
    const [pan, setPan] = useState({ x: 0, y: 0 })
    const panRef = useRef({ x: 0, y: 0 })
    const zoomRef = useRef(1)
    const [spaceDown, setSpaceDown] = useState(false)
    const [isPanning, setIsPanning] = useState(false)
    const panStartRef = useRef({ x: 0, y: 0 })


    // Drawing state
    const [boxes, setBoxes] = useState([]) // { id, x, y, w, h, name } in natural image pixels
    const [isDrawing, setIsDrawing] = useState(false)
    const [startPt, setStartPt] = useState(null) // { x, y } in natural pixels
    const [currentPt, setCurrentPt] = useState(null) // { x, y } in natural pixels

    // UI state
    const [exportedJson, setExportedJson] = useState('')
    const [copied, setCopied] = useState(false)

    // Add state for image scroll offset
    const [imageScroll, setImageScroll] = useState({ x: 0, y: 0 })
    const imageScrollRef = useRef({ x: 0, y: 0 })


    // Load persisted state on mount
    useEffect(() => {
        try {
            const raw = localStorage.getItem('annotator_state_v1')
            if (!raw) return
            const parsed = JSON.parse(raw)
            if (parsed?.imageUrl) setImageUrl(parsed.imageUrl)
            if (parsed?.imageName) setImageName(parsed.imageName)
            if (Array.isArray(parsed?.boxes)) setBoxes(parsed.boxes)
        } catch {
            // ignore parse/storage errors
        }
    }, [])

    // Persist state when image or boxes change
    useEffect(() => {
        try {
            const payload = JSON.stringify({
                imageUrl,
                imageName,
                boxes,
                version: 1,
                savedAt: Date.now(),
            })
            localStorage.setItem('annotator_state_v1', payload)
        } catch {
            // ignore quota/storage errors
        }
    }, [imageUrl, imageName, boxes])

    // Global key handlers for space-to-pan
    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.code === 'Space') {
                e.preventDefault()
                setSpaceDown(true)
            }
        }
        const onKeyUp = (e) => {
            if (e.code === 'Space') {
                e.preventDefault()
                setSpaceDown(false)
                setIsPanning(false)
            }
        }
        window.addEventListener('keydown', onKeyDown, { passive: false })
        window.addEventListener('keyup', onKeyUp, { passive: false })
        return () => {
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('keyup', onKeyUp)
        }
    }, [])

    // Load image from upload (as Data URL so it survives refresh)
    const onFileChange = (e) => {
        const file = e.target.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
            setImageUrl(reader.result)
            setImageName(file.name || 'uploaded-image')
            setBoxes([])
            setExportedJson('')
            setCopied(false)
            resetView()
        }
        reader.readAsDataURL(file)
    }

    /// Prepare an off-DOM image object to keep natural sizes
    useEffect(() => {
        if (!imageUrl) {
            imageRef.current = null
            requestAnimationFrame(draw)
            return
        }
        const img = new Image()
        img.onload = () => {
            imageRef.current = img
            fitCanvasToContainer()
            resetView() // ensure fresh view for new image
            requestAnimationFrame(draw)
        }
        img.src = imageUrl
        return () => {
            imageRef.current = null
        }
    }, [imageUrl])


    // Replace window resize with ResizeObserver on the container (avoids reacting to browser UI show/hide)
    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        let frame = 0
        let lastWidth = 0

        const ro = new ResizeObserver((entries) => {
            const entry = entries[0]
            // Prefer contentBoxSize when available; fall back to clientWidth
            const width =
                (entry && entry.contentBoxSize && (Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0].inlineSize : entry.contentBoxSize.inlineSize)) ||
                container.clientWidth

            // Only react to meaningful width changes (ignore tiny deltas from UI overlays)
            if (Math.abs(width - lastWidth) < 1) return
            lastWidth = width

            if (frame) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                fitCanvasToContainer()
                requestAnimationFrame(draw)
            })
        })

        ro.observe(container)
        return () => {
            if (frame) cancelAnimationFrame(frame)
            ro.disconnect()
        }
    }, [])


    // Ensure canvas matches container width and preserves image aspect
    const fitCanvasToContainer = () => {
        const canvas = canvasRef.current
        const container = containerRef.current
        const img = imageRef.current
        if (!canvas || !container || !img) return

        // Calculate available space accounting for padding
        const containerWidth = container.clientWidth - 32 // 16px padding each side
        const containerHeight = container.clientHeight - 32 // 16px padding each side
        const aspect = img.naturalWidth / img.naturalHeight

        // Size the canvas to show the full image width, but allow it to be taller than container
        const nextCssWidth = Math.min(containerWidth, img.naturalWidth)
        const nextCssHeight = Math.round(nextCssWidth / aspect)

        const dpr = window.devicePixelRatio || 1
        const nextPixelWidth = Math.round(nextCssWidth * dpr)
        const nextPixelHeight = Math.round(nextCssHeight * dpr)

        // Avoid resetting sizes if unchanged
        const curCssWidth = parseInt(canvas.style.width || '0', 10)
        const curCssHeight = parseInt(canvas.style.height || '0', 10)
        if (curCssWidth === nextCssWidth && curCssHeight === nextCssHeight && canvas.width === nextPixelWidth && canvas.height === nextPixelHeight) {
            return
        }

        canvas.style.width = `${nextCssWidth}px`
        canvas.style.height = `${nextCssHeight}px`
        canvas.width = nextPixelWidth
        canvas.height = nextPixelHeight

        // Reset scroll when canvas size changes
        imageScrollRef.current = { x: 0, y: 0 }
        setImageScroll({ x: 0, y: 0 })

        // After resize, keep pan inside bounds
        const clamped = clampPan(zoomRef.current, panRef.current)
        panRef.current = clamped
        setPan(clamped)
    }



    // Compute allowed pan range so image stays within canvas bounds
    const getPanBounds = (z) => {
        const canvas = canvasRef.current
        if (!canvas) return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
        const cw = canvas.width
        const ch = canvas.height

        const contentW = z * cw
        const contentH = z * ch

        // If content smaller than viewport, lock pan to centered value
        if (contentW <= cw && contentH <= ch) {
            const cx = (cw - contentW) / 2
            const cy = (ch - contentH) / 2
            return { minX: cx, maxX: cx, minY: cy, maxY: cy }
        }

        // Independently clamp axes
        const bounds = {
            minX: Math.min(0, cw - contentW),
            maxX: 0,
            minY: Math.min(0, ch - contentH),
            maxY: 0,
        }

        // If one axis is smaller, center that axis
        if (contentW <= cw) {
            const cx = (cw - contentW) / 2
            bounds.minX = cx
            bounds.maxX = cx
        }
        if (contentH <= ch) {
            const cy = (ch - contentH) / 2
            bounds.minY = cy
            bounds.maxY = cy
        }

        return bounds
    }

    const clampPan = (z, p) => {
        const { minX, maxX, minY, maxY } = getPanBounds(z)
        return {
            x: Math.min(maxX, Math.max(minX, p.x)),
            y: Math.min(maxY, Math.max(minY, p.y)),
        }
    }

    const resetView = () => {
        const z = 1
        zoomRef.current = z
        setZoom(z)
        // Center if needed (in case canvas vs DPR sizes differ)
        const centered = clampPan(z, { x: 0, y: 0 })
        panRef.current = centered
        setPan(centered)
    }


    // Convert a canvas client point to image natural pixels, accounting for pan/zoom
    const eventToImageCoords = (evt) => {
        const canvas = canvasRef.current
        const img = imageRef.current
        if (!canvas || !img) return { x: 0, y: 0 }
        const rect = canvas.getBoundingClientRect()
        const dpr = window.devicePixelRatio || 1

        // Canvas pixel coordinates
        const cx = (evt.clientX - rect.left) * dpr
        const cy = (evt.clientY - rect.top) * dpr

        // Inverse pan/zoom transform
        const z = zoomRef.current
        const px = panRef.current.x
        const py = panRef.current.y
        const vx = (cx - px) / z
        const vy = (cy - py) / z

        // Convert canvas drawing space -> natural image pixels
        const sx = img.naturalWidth / canvas.width
        const sy = img.naturalHeight / canvas.height

        return {
            x: Math.max(0, Math.min(img.naturalWidth, Math.round(vx * sx))),
            y: Math.max(0, Math.min(img.naturalHeight, Math.round(vy * sy))),
        }
    }

    // Mouse handlers
    const onMouseDown = (e) => {
        if (!imageRef.current) return

        if (spaceDown) {
            // Start panning
            setIsPanning(true)
            const rect = canvasRef.current.getBoundingClientRect()
            const dpr = window.devicePixelRatio || 1
            panStartRef.current = {
                x: (e.clientX - rect.left) * dpr - panRef.current.x,
                y: (e.clientY - rect.top) * dpr - panRef.current.y,
            }
            return
        }

        // Start drawing
        const pt = eventToImageCoords(e)
        setStartPt(pt)
        setCurrentPt(pt)
        setIsDrawing(true)
    }

    const onMouseMove = (e) => {
        if (isPanning) {
            // Update pan relative to start and clamp to bounds
            const rect = canvasRef.current.getBoundingClientRect()
            const dpr = window.devicePixelRatio || 1
            const raw = {
                x: (e.clientX - rect.left) * dpr - panStartRef.current.x,
                y: (e.clientY - rect.top) * dpr - panStartRef.current.y,
            }
            const clamped = clampPan(zoomRef.current, raw)
            panRef.current = clamped
            setPan(clamped)
            requestAnimationFrame(draw)
            return
        }

        if (!isDrawing) return
        const pt = eventToImageCoords(e)
        setCurrentPt(pt)
        requestAnimationFrame(draw)
    }
    const endInteractions = () => {
        setIsPanning(false)
        if (!isDrawing || !startPt || !currentPt) {
            setIsDrawing(false)
            return
        }
        const x = Math.min(startPt.x, currentPt.x)
        const y = Math.min(startPt.y, currentPt.y)
        const w = Math.abs(currentPt.x - startPt.x)
        const h = Math.abs(currentPt.y - startPt.y)

        if (w > 5 && h > 5) {
            setBoxes((prev) => [
                ...prev,
                {
                    id: crypto.randomUUID(),
                    x,
                    y,
                    w,
                    h,
                    name: '',
                },
            ])
        }
        setIsDrawing(false)
        setStartPt(null)
        setCurrentPt(null)
        requestAnimationFrame(draw)
    }

    const onMouseUp = () => endInteractions()
    const onMouseLeave = () => endInteractions()

    // Modified wheel handler to handle image scrolling
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return

        const wheelHandler = (e) => {
            // Always prevent default to stop page scrolling
            e.preventDefault()
            e.stopPropagation()

            // Zoom with Ctrl/Cmd
            if (e.ctrlKey || e.metaKey) {
                const rect = canvas.getBoundingClientRect()
                const dpr = window.devicePixelRatio || 1

                const mx = (e.clientX - rect.left) * dpr
                const my = (e.clientY - rect.top) * dpr

                const delta = -e.deltaY
                const factor = Math.exp(delta * 0.0015)
                const minZ = 0.2
                const maxZ = 8

                const oldZ = zoomRef.current
                const newZ = Math.min(maxZ, Math.max(minZ, oldZ * factor))
                if (newZ === oldZ) return

                // Zoom towards cursor and clamp pan to keep image edges within viewport
                const rawPanX = mx - ((mx - panRef.current.x) * newZ) / oldZ
                const rawPanY = my - ((my - panRef.current.y) * newZ) / oldZ
                const clamped = clampPan(newZ, { x: rawPanX, y: rawPanY })

                zoomRef.current = newZ
                panRef.current = clamped
                setZoom(newZ)
                setPan(clamped)
                requestAnimationFrame(draw)
                return
            }

            // Handle space + wheel for panning
            if (spaceDown) {
                const lineHeight = 16
                const scale = e.deltaMode === 1 ? lineHeight : 1
                const dX = e.shiftKey ? e.deltaY : e.deltaX
                const dY = e.shiftKey ? 0 : e.deltaY

                const raw = {
                    x: panRef.current.x - dX * scale,
                    y: panRef.current.y - dY * scale,
                }
                const clamped = clampPan(zoomRef.current, raw)
                panRef.current = clamped
                setPan(clamped)
                requestAnimationFrame(draw)
                return
            }

            // Regular wheel scrolling - scroll the container instead of panning the image
            const container = containerRef.current
            if (container) {
                const scrollSpeed = 50
                const deltaY = e.deltaY
                const deltaX = e.shiftKey ? e.deltaY : e.deltaX

                // Scroll the container
                container.scrollTop += deltaY * (scrollSpeed / 100)
                if (!e.shiftKey && e.deltaX) {
                    container.scrollLeft += deltaX * (scrollSpeed / 100)
                }
            }
        }

        canvas.addEventListener('wheel', wheelHandler, { passive: false })
        return () => canvas.removeEventListener('wheel', wheelHandler)
    }, [spaceDown]) // Add spaceDown as dependency





    // Core render to canvas
    const draw = () => {
        const canvas = canvasRef.current
        const ctx = canvas?.getContext('2d')
        const img = imageRef.current
        if (!canvas || !ctx) return

        // Clear to white
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)

        if (!img) {
            ctx.fillStyle = '#f5f5f5'
            ctx.fillRect(0, 0, canvas.width, canvas.height)
            ctx.fillStyle = '#888'
            ctx.font = `${14 * (window.devicePixelRatio || 1)}px sans-serif`
            ctx.fillText('Upload an image to start annotating', 12, 28)
            return
        }

        // Apply pan/zoom (already clamped)
        ctx.setTransform(zoomRef.current, 0, 0, zoomRef.current, panRef.current.x, panRef.current.y)

        // Draw image scaled to canvas drawing size
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)


        // Helper for converting natural -> canvas drawing pixels (pre-transform)
        const sx = canvas.width / img.naturalWidth
        const sy = canvas.height / img.naturalHeight

        // Draw existing boxes
        boxes.forEach((b, idx) => {
            const x = Math.round(b.x * sx)
            const y = Math.round(b.y * sy)
            const w = Math.round(b.w * sx)
            const h = Math.round(b.h * sy)

            ctx.lineWidth = 2
            ctx.strokeStyle = '#2dd4bf'
            ctx.strokeRect(x, y, w, h)

            const label = b.name || `Field ${idx + 1}`
            ctx.font = `${12 * (window.devicePixelRatio || 1)}px sans-serif`
            const padding = 4
            const metrics = ctx.measureText(label)
            const labelW = Math.ceil(metrics.width) + padding * 2
            const labelH = 18

            // Label background and text
            ctx.fillStyle = 'rgba(45, 212, 191, 0.85)'
            ctx.fillRect(x, Math.max(0, y - labelH), labelW, labelH)
            ctx.fillStyle = '#053b37'
            ctx.fillText(label, x + padding, Math.max(12, y - 6))
        })

        // Draw active rectangle
        if (isDrawing && startPt && currentPt) {
            const x = Math.min(startPt.x, currentPt.x) * sx
            const y = Math.min(startPt.y, currentPt.y) * sy
            const w = Math.abs(currentPt.x - startPt.x) * sx
            const h = Math.abs(currentPt.y - startPt.y) * sy

            ctx.setLineDash([6, 4])
            ctx.lineWidth = 2
            ctx.strokeStyle = '#f97316'
            ctx.strokeRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
            ctx.setLineDash([])
        }
    }

    // Redraw when boxes or view change
    useEffect(() => {
        requestAnimationFrame(draw)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [boxes, isDrawing, startPt, currentPt, zoom, pan])

    // Box list editing
    const updateBoxName = (id, name) => {
        setBoxes((prev) => prev.map((b) => (b.id === id ? { ...b, name } : b)))
    }

    const deleteBox = (id) => {
        setBoxes((prev) => prev.filter((b) => b.id !== id))
    }

    const clearAll = () => {
        setBoxes([])
        setExportedJson('')
        setCopied(false)
        setImageUrl(null)
        setImageName('uploaded-image')
        try {
            localStorage.removeItem('annotator_state_v1')
        } catch {
            // ignore
        }
        resetView()
        requestAnimationFrame(draw)
    }

    // Export JSON in natural image pixels and also percentages for portability
    const exportJson = () => {
        const img = imageRef.current
        if (!img) return
        const payload = {
            image: {
                name: imageName || 'uploaded-image',
                width: img.naturalWidth,
                height: img.naturalHeight,
            },
            fields: boxes.map((b) => {
                const px = { x: b.x, y: b.y, width: b.w, height: b.h }
                const pct = {
                    x: +(b.x / img.naturalWidth).toFixed(6),
                    y: +(b.y / img.naturalHeight).toFixed(6),
                    width: +(b.w / img.naturalWidth).toFixed(6),
                    height: +(b.h / img.naturalHeight).toFixed(6),
                }
                return {
                    id: b.id,
                    name: b.name || '',
                    pixels: px,
                    percent: pct,
                }
            }),
        }
        const json = JSON.stringify(payload, null, 2)
        setExportedJson(json)
        setCopied(false)
    }

    const copyToClipboard = async () => {
        if (!exportedJson) return
        try {
            await navigator.clipboard.writeText(exportedJson)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            setCopied(false)
        }
    }

    return (
        <div className="page">
            <header className="header">
                <h1>Form Field Bounding Box Generator</h1>
                <div className="controls">
                    <label className="file">
                        <input type="file" accept="image/*" onChange={onFileChange} />
                    </label>
                    <button onClick={resetView} title="Reset zoom and pan">
                        Reset View
                    </button>
                    <button className="danger" onClick={clearAll} disabled={!imageUrl && boxes.length === 0}>
                        Reset
                    </button>
                    <button className="primary" onClick={exportJson} disabled={!imageUrl || boxes.length === 0}>
                        Export JSON
                    </button>
                    <button onClick={copyToClipboard} disabled={!exportedJson}>
                        {copied ? 'Copied!' : 'Copy JSON'}
                    </button>
                </div>
            </header>

            <main className="main">
                <section className="canvas-pane" ref={containerRef}>
                    <div className="canvas-container">
                        <canvas
                            ref={canvasRef}
                            className={`canvas ${!imageUrl ? 'canvas--empty' : ''} ${spaceDown || isPanning ? 'canvas--grab' : ''}`}
                            onMouseDown={onMouseDown}
                            onMouseMove={onMouseMove}
                            onMouseUp={onMouseUp}
                            onMouseLeave={onMouseLeave}
                        />
                    </div>
                    {!imageUrl && (
                        <div className="placeholder">
                            <p>Upload an image, then click and drag to draw boxes.</p>
                            <p>Tip: Hold Space to pan. Ctrl/Cmd + mouse wheel to zoom.</p>
                        </div>
                    )}
                </section>

                <aside className="side">
                    <h2>Fields ({boxes.length})</h2>
                    {boxes.length === 0 ? (
                        <p className="muted">No fields yet. Draw a box on the image.</p>
                    ) : (
                        <ul className="list">
                            {boxes.map((b, idx) => (
                                <li key={b.id} className="list-item">
                                    <div className="row">
                                        <span className="badge">{idx + 1}</span>
                                        <input
                                            className="name-input"
                                            placeholder="Field name (e.g., Policy Number)"
                                            value={b.name}
                                            onChange={(e) => updateBoxName(b.id, e.target.value)}
                                        />
                                        <button className="link danger" onClick={() => deleteBox(b.id)} title="Delete field">
                                            Remove
                                        </button>
                                    </div>
                                    <div className="coords">
                                        x: {b.x}, y: {b.y}, w: {b.w}, h: {b.h}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}

                    <h2>JSON</h2>
                    <textarea
                        className="json"
                        value={exportedJson}
                        onChange={(e) => setExportedJson(e.target.value)}
                        placeholder="Click Export JSON to generate..."
                    />
                </aside>
            </main>

            <footer className="footer">
                <small>
                    Tips: Click and drag to draw. Hold Space to pan. Use Ctrl/Cmd + wheel to zoom. Your work is saved locally.
                </small>
            </footer>
        </div>
    )
}


export default App
