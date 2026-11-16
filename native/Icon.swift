import AppKit
let destination = CommandLine.arguments[1]
for size in [16,32,64,128,256,512,1024] {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    let transform = NSAffineTransform(); transform.scale(by: CGFloat(size) / 1024); transform.concat()
    NSColor(calibratedRed: 0.055, green: 0.075, blue: 0.065, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944), xRadius: 210, yRadius: 210).fill()
    let green = NSColor(calibratedRed: 0.51, green: 0.86, blue: 0.63, alpha: 1)
    green.setStroke()
    let roof = NSBezierPath(); roof.lineWidth = 38; roof.lineCapStyle = .round; roof.lineJoinStyle = .round
    roof.move(to: NSPoint(x: 242,y: 526)); roof.line(to: NSPoint(x: 512,y: 754)); roof.line(to: NSPoint(x: 782,y: 526)); roof.stroke()
    let path = NSBezierPath(); path.lineWidth = 32; path.lineCapStyle = .round
    path.move(to: NSPoint(x: 326,y: 485)); path.line(to: NSPoint(x: 326,y: 320)); path.line(to: NSPoint(x: 698,y: 320)); path.line(to: NSPoint(x: 698,y: 485)); path.stroke()
    for point in [NSPoint(x: 326,y: 485),NSPoint(x: 512,y: 320),NSPoint(x: 698,y: 485)] { green.setFill(); NSBezierPath(roundedRect: NSRect(x: point.x-55,y: point.y-55,width: 110,height: 110),xRadius: 28,yRadius: 28).fill() }
    image.unlockFocus()
    let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
    let data = rep.representation(using: .png, properties: [:])!
    try data.write(to: URL(fileURLWithPath: destination).appendingPathComponent("icon-\(size).png"))
}
