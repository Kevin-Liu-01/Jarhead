#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Error domain of an NSException caught by `JHTry`.
FOUNDATION_EXPORT NSErrorDomain const JHObjCExceptionErrorDomain;
/// `userInfo` keys on that error: the exception's name, its reason, and the first frames
/// of the stack it was raised from (one symbol per line).
FOUNDATION_EXPORT NSErrorUserInfoKey const JHExceptionNameKey;
FOUNDATION_EXPORT NSErrorUserInfoKey const JHExceptionReasonKey;
FOUNDATION_EXPORT NSErrorUserInfoKey const JHExceptionCallStackKey;

/// Runs `block`. An Objective-C exception raised inside it — AVFoundation's
/// "required condition is false: …", "Failed to create tap due to format mismatch",
/// "player started when engine not running" — is caught and handed back as an NSError
/// in `JHObjCExceptionErrorDomain` instead of aborting the process (Swift cannot catch
/// NSExceptions; uncaught, one takes the whole app down).
///
/// Returns YES when the block ran to completion, NO when an exception was caught
/// (`error` is filled in when non-NULL). Objects the block had in flight are leaked,
/// not released, when it is cut short: keep the block to the one framework call.
FOUNDATION_EXPORT BOOL JHTry(void (NS_NOESCAPE ^block)(void), NSError * _Nullable __autoreleasing * _Nullable error);

NS_ASSUME_NONNULL_END
