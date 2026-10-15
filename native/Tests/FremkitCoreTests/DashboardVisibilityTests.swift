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
    func testMenuLabelsAreWrittenInBothLanguages() {
        XCTAssertEqual(L10n.string(.hideDashboard, language: .fr), "Masquer")
        XCTAssertEqual(L10n.string(.showDashboard, language: .fr), "Réafficher")
        XCTAssertEqual(L10n.string(.hideDashboard, language: .en), "Hide")
        XCTAssertEqual(L10n.string(.showDashboard, language: .en), "Show")
    }
}
