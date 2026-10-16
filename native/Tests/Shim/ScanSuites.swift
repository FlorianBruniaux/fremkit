// Registry of the disk scanner's tests, kept apart from main.swift so the suites other branches add
// there and these do not touch the same lines. Same rule as main.swift: every test method is listed,
// and scripts/test-helper.sh counts the entries of every file in this folder.

import XCTest

let scanSuites: [(String, () -> XCTestCase, [TestMethod])] = [
    ("DiskTreeTests", { DiskTreeTests() }, [
        ("testSizesAddUpThroughTheTree", { ($0 as! DiskTreeTests).testSizesAddUpThroughTheTree() }),
        ("testHardLinkedFileCountsOnce", { ($0 as! DiskTreeTests).testHardLinkedFileCountsOnce() }),
        ("testSmallEntriesAndTheTailGoIntoOthers", { ($0 as! DiskTreeTests).testSmallEntriesAndTheTailGoIntoOthers() }),
        ("testDroppingAFolderBigEnoughToDrawMarksMore", { ($0 as! DiskTreeTests).testDroppingAFolderBigEnoughToDrawMarksMore() }),
        ("testEntriesBelowTheDepthAreNotHeldButCounted", { ($0 as! DiskTreeTests).testEntriesBelowTheDepthAreNotHeldButCounted() }),
        ("testUnreadableDirectoriesAreKeptAndCountedNeverAsSmall", { ($0 as! DiskTreeTests).testUnreadableDirectoriesAreKeptAndCountedNeverAsSmall() }),
        ("testBudgetKeepsTheLargestNodesAndFoldsTheRest", { ($0 as! DiskTreeTests).testBudgetKeepsTheLargestNodesAndFoldsTheRest() }),
        ("testJSONEscapesNamesAndLeavesDefaultsOut", { ($0 as! DiskTreeTests).testJSONEscapesNamesAndLeavesDefaultsOut() }),
        ("testArgumentsParseWithDefaults", { try ($0 as! DiskTreeTests).testArgumentsParseWithDefaults() }),
        ("testArgumentsRefuseWhatIsOutOfBounds", { ($0 as! DiskTreeTests).testArgumentsRefuseWhatIsOutOfBounds() }),
    ]),
    ("DiskWalkerTests", { DiskWalkerTests() }, [
        ("testCountsAllocatedSizesLikeLstat", { try ($0 as! DiskWalkerTests).testCountsAllocatedSizesLikeLstat() }),
        ("testHardLinksCountOnce", { try ($0 as! DiskWalkerTests).testHardLinksCountOnce() }),
        ("testSymlinksAreNeverFollowedEvenInALoop", { try ($0 as! DiskWalkerTests).testSymlinksAreNeverFollowedEvenInALoop() }),
        ("testUnreadableDirectoryIsReportedNotCountedAsEmpty", { try ($0 as! DiskWalkerTests).testUnreadableDirectoryIsReportedNotCountedAsEmpty() }),
        ("testAnotherDeviceIsNotCrossed", { try ($0 as! DiskWalkerTests).testAnotherDeviceIsNotCrossed() }),
        ("testCancellationStopsTheWalk", { ($0 as! DiskWalkerTests).testCancellationStopsTheWalk() }),
        ("testMissingRootIsAnError", { ($0 as! DiskWalkerTests).testMissingRootIsAnError() }),
        ("testFinishedDirectoriesAreReportedDownToTheProgressDepth", { try ($0 as! DiskWalkerTests).testFinishedDirectoriesAreReportedDownToTheProgressDepth() }),
    ]),
]
