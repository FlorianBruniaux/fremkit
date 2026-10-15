import XCTest
@testable import FremkitCore

final class DashboardVisibilityTests: XCTestCase {
    func testUserHideSurvivesDisplayReconfiguration() {
        var state = DashboardVisibility()
        XCTAssertTrue(state.shouldShow)
        state.hide()
        XCTAssertFalse(state.shouldShow)
        state.displayAvailable = false
        state.displayAvailable = true
        XCTAssertFalse(state.shouldShow)
        state.show()
        XCTAssertTrue(state.shouldShow)
    }
    func testShowingWithoutDisplayKeepsWindowAbsent() {
        var state = DashboardVisibility()
        state.displayAvailable = false
        state.hide()
        state.show()
        XCTAssertFalse(state.shouldShow)
        state.displayAvailable = true
        XCTAssertTrue(state.shouldShow)
    }
}
