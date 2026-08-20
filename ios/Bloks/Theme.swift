// The two brand colours, mirroring src/styles.css by hand.
//
// The accent is --brand-ink, not --brand. Those are two values on the
// Mac for a reason worth repeating here: brand colour as a fill is a
// surface, and 4.17 to 1 is fine for a surface, but the moment words sit
// on it or it becomes words itself the bar is 4.5 and the lighter blue
// misses it. The phone had neither. It used the iOS system blue, which
// is 4.02 to 1 under white, and every outgoing bubble in the app is
// white on it.
//
// So AccentColor carries the ink, which reads both ways: as tinted text
// on the page, and as a fill with something on top. And brandForeground
// is what goes on top, which is white in light and near black in dark,
// because the dark blue is light enough that white on it is only 3 to 1.
// That is exactly the pairing --brand-foreground makes on the Mac.
import SwiftUI

extension Color {
    /// What goes on an accent fill. Never `.white`: in dark mode the
    /// accent is light enough that white on it cannot be read.
    static let brandForeground = Color("BrandForeground")

    /// --destructive, for the one place red carries words. The system
    /// red is right for a hang up button, which is a glyph and only
    /// needs 3 to 1, and wrong for a sentence: white on it is 3.3 to 1,
    /// and the sentence in question is the one saying what went wrong.
    static let danger = Color("Danger")
    static let dangerForeground = Color("DangerForeground")
}
