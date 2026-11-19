cmake_minimum_required(VERSION 3.22.1)
project(tensorfold_jni)

add_library(tensorfold_mobile SHARED IMPORTED GLOBAL)
set_target_properties(tensorfold_mobile PROPERTIES
    IMPORTED_LOCATION "${TF_ENGINE_ROOT}/out/android/${ANDROID_ABI}/libtensorfold_mobile.so"
    INTERFACE_INCLUDE_DIRECTORIES "${TF_ENGINE_ROOT}/include")

add_library(tensorfold_jni SHARED tensorfold_jni.cpp)
target_link_libraries(tensorfold_jni tensorfold_mobile android log)
target_include_directories(tensorfold_jni PRIVATE "${TF_ENGINE_ROOT}/include")
