// Liquid Glass, with a floor under it.
//
// The design language this app wants is the iOS 26 one: controls as glass
// capsules floating over content. The real material only exists on iOS 26,
// and the deployment target is 17, so every use goes through these helpers
// and gets the honest fallback: a thin material with a hairline stroke,
// which reads as the same design without pretending to refract anything.
import SwiftUI

extension View {
    /// A glass capsule around this view: the shape of the composer field,
    /// the search field, and every pill-shaped control.
    @ViewBuilder
    func glassCapsule(interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(interactive ? .regular.interactive() : .regular, in: .capsule)
        } else {
            self
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
        }
    }

    /// A glass circle: the compose button, the attach button.
    @ViewBuilder
    func glassCircle(interactive: Bool = true) -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(interactive ? .regular.interactive() : .regular, in: .circle)
        } else {
            self
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
        }
    }
}

/// Groups glass shapes so that on iOS 26 they share one sampling region
/// and blend when they get close, which is what makes a row of controls
/// read as one instrument rather than three stickers. Everywhere else it
/// is just its content.
struct GlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}
