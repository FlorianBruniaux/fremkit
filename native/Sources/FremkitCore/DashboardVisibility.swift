/// User visibility survives display loss and geometry changes; data collection is independent.
public struct DashboardVisibility {
    public private(set) var hiddenByUser = false
    public var displayAvailable = true
    public var shouldShow: Bool { displayAvailable && !hiddenByUser }
    public init() {}
    public mutating func hide() { hiddenByUser = true }
    public mutating func show() { hiddenByUser = false }
}
