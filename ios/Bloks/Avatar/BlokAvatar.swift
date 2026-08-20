// Blok avatars, pixel edition.
//
// A black pixel creature on a coloured tile with smooth white eyes: crisp
// bitmap silhouette, soft face. The contrast is the whole charm, so the
// body is drawn as hard rectangles with no antialiasing help and the face
// as smooth curves on top.
//
// The bitmaps and palette come from Bitmaps.swift, which is generated from
// the web client. The geometry below is a hand port of the drawing code in
// src/components/Avatar.tsx, working in the same 100x100 space as that
// file's viewBox so every number here can be diffed against it directly.
//
// If Face() in Avatar.tsx changes, this changes too. Nothing warns you.
import SwiftUI

/// The tile outline. The desktop draws a rounded square (rx 24 of 100).
/// Messages draws contact avatars as circles, and the conversation list
/// follows that convention, so both are available.
enum BlokTile {
    case rounded
    case circle
}

struct BlokAvatar: View {
    let color: BlokColor
    let shape: BlokShape
    var expression: BlokExpression = .deadpan
    var size: CGFloat = 40
    var tile: BlokTile = .rounded
    /// Read out by VoiceOver. Nil hides the avatar from the accessibility
    /// tree, which is right when the name is already adjacent to it.
    var label: String?

    var body: some View {
        Canvas(rendersAsynchronously: false) { context, canvasSize in
            let scale = canvasSize.width / 100
            context.scaleBy(x: scale, y: scale)
            draw(in: &context)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(label == nil)
        .accessibilityLabel(label ?? "")
    }

    private func draw(in context: inout GraphicsContext) {
        let base = Color(hex: BlokArt.colorHex[color] ?? 0x4C86F5)
        // mix(base, #000000, 0.22): the dither band is the base colour
        // darkened, never a separate hue.
        let deep = Color(hex: BlokArt.colorHex[color] ?? 0x4C86F5, darkenedBy: 0.22)

        let outline: Path
        switch tile {
        case .rounded:
            outline = Path(roundedRect: CGRect(x: 0, y: 0, width: 100, height: 100), cornerRadius: 24)
        case .circle:
            outline = Path(ellipseIn: CGRect(x: 0, y: 0, width: 100, height: 100))
        }

        context.clip(to: outline)
        context.fill(outline, with: .color(base))

        // The dithered foot band: a checkerboard along the bottom that
        // fades upward. Same predicate as DITHER_CELLS in Avatar.tsx.
        let dcell: Double = 5
        var dither = Path()
        let n = 20
        for y in 17..<n {
            for x in 0..<n {
                guard (x + y) % 2 == 0, y > 17 || x % 4 < 2 else { continue }
                dither.addRect(
                    CGRect(x: Double(x) * dcell, y: Double(y) * dcell, width: dcell, height: dcell)
                )
            }
        }
        context.fill(dither, with: .color(deep))

        let bitmap = BlokArt.bitmaps[shape] ?? BlokArt.bitmaps[.star]!

        // Body. Runs of '#' become one rect each, which keeps the path
        // small and the edges exact.
        var body = Path()
        let cell = BlokArt.cell
        let offset = BlokArt.boxOffset
        for (y, row) in bitmap.rows.enumerated() {
            let chars = Array(row)
            var x = 0
            while x < chars.count {
                guard chars[x] == "#" else {
                    x += 1
                    continue
                }
                var width = 0
                while x + width < chars.count, chars[x + width] == "#" { width += 1 }
                body.addRect(
                    CGRect(
                        x: offset + Double(x) * cell,
                        y: offset + Double(y) * cell,
                        width: Double(width) * cell,
                        height: cell
                    )
                )
                x += width
            }
        }
        context.fill(body, with: .color(Color(hex: 0x101013)))

        // Face glyphs are drawn relative to the tile centre, exactly as the
        // web client's `translate(50 50)` group does.
        let faceY = offset + bitmap.faceY * cell - 50
        context.translateBy(x: 50, y: 50)
        drawFace(in: &context, fy: faceY)
    }

    // MARK: The face

    private func drawFace(in context: inout GraphicsContext, fy: Double) {
        let white = GraphicsContext.Shading.color(.white)
        let stroke = StrokeStyle(lineWidth: 3.4, lineCap: .round, lineJoin: .round)

        func eye(_ x: Double, tilt: Double = 0, dy: Double = 0) {
            let cy = fy - 3 + dy
            var path = Path(ellipseIn: CGRect(x: x - 4, y: cy - 6.5, width: 8, height: 13))
            if tilt != 0 {
                let transform = CGAffineTransform(translationX: x, y: cy)
                    .rotated(by: tilt * .pi / 180)
                    .translatedBy(x: -x, y: -cy)
                path = path.applying(transform)
            }
            context.fill(path, with: white)
        }

        func line(_ build: (inout Path) -> Void) {
            var path = Path()
            build(&path)
            context.stroke(path, with: white, style: stroke)
        }

        switch expression {
        case .deadpan:
            eye(-8)
            eye(8)

        case .friendly:
            eye(-8, tilt: -8)
            eye(8, tilt: 8)
            line { p in
                p.move(to: CGPoint(x: -6, y: fy + 8))
                p.addQuadCurve(to: CGPoint(x: 6, y: fy + 8), control: CGPoint(x: 0, y: fy + 12))
            }

        case .focused:
            line { p in
                p.move(to: CGPoint(x: -13, y: fy - 3))
                p.addLine(to: CGPoint(x: -4, y: fy - 3))
                p.move(to: CGPoint(x: 4, y: fy - 3))
                p.addLine(to: CGPoint(x: 13, y: fy - 3))
                p.move(to: CGPoint(x: -5, y: fy + 8))
                p.addLine(to: CGPoint(x: 5, y: fy + 8))
            }

        case .thinking:
            eye(-8, tilt: 12, dy: -1.5)
            eye(8, tilt: -12, dy: -1.5)
            line { p in
                p.move(to: CGPoint(x: -5, y: fy + 9))
                p.addLine(to: CGPoint(x: 6, y: fy + 6))
            }

        case .excited:
            line { p in
                p.move(to: CGPoint(x: -12, y: fy - 2))
                p.addQuadCurve(to: CGPoint(x: -4, y: fy - 2), control: CGPoint(x: -8, y: fy - 8.5))
                p.move(to: CGPoint(x: 4, y: fy - 2))
                p.addQuadCurve(to: CGPoint(x: 12, y: fy - 2), control: CGPoint(x: 8, y: fy - 8.5))
            }
            var mouth = Path()
            mouth.move(to: CGPoint(x: -7, y: fy + 5))
            mouth.addQuadCurve(to: CGPoint(x: 7, y: fy + 5), control: CGPoint(x: 0, y: fy + 13))
            mouth.addQuadCurve(to: CGPoint(x: -7, y: fy + 5), control: CGPoint(x: 0, y: fy + 8))
            mouth.closeSubpath()
            context.fill(mouth, with: white)

        case .sleepy:
            line { p in
                p.move(to: CGPoint(x: -12, y: fy - 4))
                p.addQuadCurve(to: CGPoint(x: -4, y: fy - 4), control: CGPoint(x: -8, y: fy))
                p.move(to: CGPoint(x: 4, y: fy - 4))
                p.addQuadCurve(to: CGPoint(x: 12, y: fy - 4), control: CGPoint(x: 8, y: fy))
            }
            context.fill(
                Path(ellipseIn: CGRect(x: -2.6, y: fy + 8 - 3.2, width: 5.2, height: 6.4)),
                with: white
            )

        case .surprised:
            context.fill(Path(ellipseIn: CGRect(x: -8 - 4.6, y: fy - 3 - 4.6, width: 9.2, height: 9.2)), with: white)
            context.fill(Path(ellipseIn: CGRect(x: 8 - 4.6, y: fy - 3 - 4.6, width: 9.2, height: 9.2)), with: white)
            context.fill(Path(ellipseIn: CGRect(x: -3.4, y: fy + 8 - 3.4, width: 6.8, height: 6.8)), with: white)

        case .skeptical:
            line { p in
                p.move(to: CGPoint(x: -13, y: fy - 6))
                p.addLine(to: CGPoint(x: -4, y: fy - 4))
            }
            eye(8, dy: -1)
            line { p in
                p.move(to: CGPoint(x: -6, y: fy + 9))
                p.addQuadCurve(to: CGPoint(x: 6, y: fy + 9), control: CGPoint(x: 0, y: fy + 6))
            }

        case .worried:
            line { p in
                p.move(to: CGPoint(x: -12, y: fy - 2))
                p.addQuadCurve(to: CGPoint(x: -4, y: fy - 2), control: CGPoint(x: -8, y: fy - 7))
                p.move(to: CGPoint(x: 4, y: fy - 2))
                p.addQuadCurve(to: CGPoint(x: 12, y: fy - 2), control: CGPoint(x: 8, y: fy - 7))
            }
            line { p in
                p.move(to: CGPoint(x: -6, y: fy + 11))
                p.addQuadCurve(to: CGPoint(x: 6, y: fy + 11), control: CGPoint(x: 0, y: fy + 6))
            }

        case .mischievous:
            line { p in
                p.move(to: CGPoint(x: -13, y: fy - 8))
                p.addLine(to: CGPoint(x: -4, y: fy - 4))
                p.move(to: CGPoint(x: 13, y: fy - 8))
                p.addLine(to: CGPoint(x: 4, y: fy - 4))
            }
            var grin = Path()
            grin.move(to: CGPoint(x: -7, y: fy + 6))
            grin.addQuadCurve(to: CGPoint(x: 8, y: fy + 4), control: CGPoint(x: 1, y: fy + 12))
            grin.addQuadCurve(to: CGPoint(x: -7, y: fy + 6), control: CGPoint(x: 1, y: fy + 8))
            grin.closeSubpath()
            context.fill(grin, with: white)
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }

    /// mix(hex, #000000, amount) from src/components/Avatar.tsx.
    init(hex: UInt32, darkenedBy amount: Double) {
        let keep = 1 - amount
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255 * keep,
            green: Double((hex >> 8) & 0xFF) / 255 * keep,
            blue: Double(hex & 0xFF) / 255 * keep,
            opacity: 1
        )
    }
}
