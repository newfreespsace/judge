#pragma once

// Newer fmt releases define the std::filesystem::path formatter in this header.
#if __has_include(<fmt/std.h>)
#include <fmt/std.h>
#endif
