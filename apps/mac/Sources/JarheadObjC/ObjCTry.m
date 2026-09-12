#import "ObjCTry.h"

NSErrorDomain const JHObjCExceptionErrorDomain = @"Jarhead.ObjCException";
NSErrorUserInfoKey const JHExceptionNameKey = @"JHExceptionName";
NSErrorUserInfoKey const JHExceptionReasonKey = @"JHExceptionReason";
NSErrorUserInfoKey const JHExceptionCallStackKey = @"JHExceptionCallStack";

static NSError *JHErrorFromException(NSException *exception) {
    NSString *name = exception.name ?: @"NSException";
    NSString *reason = exception.reason ?: @"(no reason)";
    NSArray<NSString *> *stack = exception.callStackSymbols ?: @[];
    NSUInteger keep = MIN(stack.count, (NSUInteger)16);
    NSMutableDictionary<NSErrorUserInfoKey, id> *info = [NSMutableDictionary dictionary];
    info[NSLocalizedDescriptionKey] = [NSString stringWithFormat:@"%@: %@", name, reason];
    info[JHExceptionNameKey] = name;
    info[JHExceptionReasonKey] = reason;
    info[JHExceptionCallStackKey] = [[stack subarrayWithRange:NSMakeRange(0, keep)] componentsJoinedByString:@"\n"];
    return [NSError errorWithDomain:JHObjCExceptionErrorDomain code:1 userInfo:info];
}

BOOL JHTry(void (NS_NOESCAPE ^block)(void), NSError * _Nullable __autoreleasing * _Nullable error) {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) *error = JHErrorFromException(exception);
        return NO;
    } @catch (id other) {
        // Something that is not an NSException was thrown (rare; a bare object).
        if (error) {
            NSString *text = [NSString stringWithFormat:@"non-NSException object thrown: %@", other];
            *error = [NSError errorWithDomain:JHObjCExceptionErrorDomain code:2 userInfo:@{
                NSLocalizedDescriptionKey: text,
                JHExceptionNameKey: @"(not an NSException)",
                JHExceptionReasonKey: text,
                JHExceptionCallStackKey: @"",
            }];
        }
        return NO;
    }
}
