/// User visibility survives display loss and geometry changes; data collection is independent.
public struct DashboardVisibility {
    public private(set) var hiddenByUser = false
    public private(set) var applicationHidden = false
    public var displayAvailable = true
    public var shouldShow: Bool { displayAvailable && !hiddenByUser && !applicationHidden }
    public init() {}
    public mutating func hide() { hiddenByUser = true }
    public mutating func show() { hiddenByUser = false }
    public mutating func applicationDidHide() { applicationHidden = true }
    public mutating func applicationDidUnhide() { applicationHidden = false }
}
