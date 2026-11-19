#include <jni.h>
#include "tensorfold_mobile.h"

extern "C" JNIEXPORT jstring JNICALL
Java_expo_modules_tensorfoldengine_TensorFoldEngineModule_nativeCapabilitiesJson(
    JNIEnv *environment,
    jobject) {
  return environment->NewStringUTF(sonar_tf_capabilities_json());
}
