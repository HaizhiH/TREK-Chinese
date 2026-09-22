require "yaml"
require "tmpdir"
require "open3"

images = [
  "huahaizhi/trek-chinese",
  "registry.cn-guangzhou.aliyuncs.com/tsugar/trek",
]
hashes = ["a" * 64, "b" * 64]
cases = {
  "amd64 and arm64" => hashes,
  "no digests" => [],
  "missing architecture" => [hashes.first],
  "extra digest" => hashes + ["c" * 64],
  "invalid digest" => [hashes.first, "invalid"],
  "empty digest name" => [hashes.first, "sha256:"],
  "digest directory" => hashes,
}

%w[docker.yml docker-dev.yml docker-publish.yml].each do |filename|
  path = File.expand_path("../.github/workflows/#{filename}", __dir__)
  workflow = YAML.load_file(path)
  step = workflow.fetch("jobs").fetch("merge").fetch("steps").find do |entry|
    entry["name"] == "Create and push multi-arch manifest"
  end
  prerelease = filename == "docker-dev.yml"
  version = prerelease ? "3.5.0-pre.1" : "3.4.2"
  script = step.fetch("run").gsub("${{ needs.version-bump.outputs.version }}", version)
  stub = "docker() { printf 'DOCKER_ARG:%s\\n' \"$@\"; }\n"

  cases.each do |name, files|
    Dir.mktmpdir("trek-manifest-") do |directory|
      if name == "no digests"
        # do nothing
      else
        # We need to simulate digests-linux-amd64 and digests-linux-arm64
        # files[0] goes to amd64, files[1] to arm64, files[2] to arm64 or just extra
        platforms = ["digests-linux-amd64", "digests-linux-arm64"]
        if name != "missing architecture"
          platforms.each { |p| Dir.mkdir(File.join(directory, p)) }
        else
          Dir.mkdir(File.join(directory, platforms[0]))
        end
        
        files.each_with_index do |digest, i|
          p = platforms[i % 2] || platforms[0]
          next unless Dir.exist?(File.join(directory, p))
          target = File.join(directory, p, digest)
          if name == "digest directory" && digest == hashes.last
            Dir.mkdir(target)
          else
            File.write(target, "")
          end
        end
      end

      stdout, stderr, status = Open3.capture3(
        {
          "IMAGE_NAME" => workflow.fetch("env").fetch("IMAGE_NAME"),
          "ACR_IMAGE" => images.last,
          "GITHUB_SHA" => "abcdef1234567890",
        },
        "bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", stub + script,
        chdir: directory,
      )
      arguments = stdout.lines.map do |line|
        line.delete_prefix("DOCKER_ARG:").chomp if line.start_with?("DOCKER_ARG:")
      end.compact
      if name == "amd64 and arm64"
        if filename == "docker-publish.yml"
          tags = ["latest", "sha-abcdef123456"]
        else
          tags = prerelease ? ["latest-pre", "3-pre", version] : ["latest", "3", version]
        end
        expected = images.flat_map do |image|
          ["buildx", "imagetools", "create"] +
            tags.flat_map { |tag| ["-t", "#{image}:#{tag}"] } +
            hashes.map { |digest| "#{image}@sha256:#{digest}" }
        end
        unless status.success? && arguments == expected
          abort "FAIL #{filename}: #{name}\n#{stdout}#{stderr}"
        end
      elsif status.success? || !arguments.empty? || !stdout.include?("::error::")
        abort "FAIL #{filename}: #{name} must fail before invoking Docker\n#{stdout}#{stderr}"
      end
      puts "PASS #{filename}: #{name}"
    end
  end
end
