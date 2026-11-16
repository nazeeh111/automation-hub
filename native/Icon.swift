import AppKit
let destination = CommandLine.arguments[1]
for size in [16,32,64,128,256,512,1024] {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    let transform = NSAffineTransform(); transform.scale(by: CGFloat(size) / 1024); transform.concat()
    NSColor(calibratedRed: 28.0/255, green: 44.0/255, blue: 61.0/255, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944), xRadius: 210, yRadius: 210).fill()
    NSColor.white.setStroke()
    let route = NSBezierPath(); route.lineWidth = 30; route.lineCapStyle = .round; route.lineJoinStyle = .round
    route.move(to: NSPoint(x: 452, y: 680)); route.line(to: NSPoint(x: 620, y: 680))
    route.curve(to: NSPoint(x: 680, y: 620), controlPoint1: NSPoint(x: 660, y: 680), controlPoint2: NSPoint(x: 680, y: 660))
    route.line(to: NSPoint(x: 680, y: 456))
    route.move(to: NSPoint(x: 340, y: 564)); route.line(to: NSPoint(x: 340, y: 380))
    route.curve(to: NSPoint(x: 380, y: 340), controlPoint1: NSPoint(x: 340, y: 350), controlPoint2: NSPoint(x: 350, y: 340))
    route.line(to: NSPoint(x: 564, y: 340)); route.stroke()
    for frame in [NSRect(x: 224, y: 564, width: 232, height: 232), NSRect(x: 564, y: 224, width: 232, height: 232)] {
        let node = NSBezierPath(roundedRect: frame, xRadius: 48, yRadius: 48); node.lineWidth = 32; node.stroke()
    }
    image.unlockFocus()
    let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
    let data = rep.representation(using: .png, properties: [:])!
    try data.write(to: URL(fileURLWithPath: destination).appendingPathComponent("icon-\(size).png"))
}
