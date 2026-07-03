package discovery

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"github.com/rs/zerolog/log"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

type PodInfo struct {
	Name        string
	Namespace   string
	NodeName    string
	UID         string
	ContainerID string   // containerd://SHA256 of the first app container (for cgroupv2 PID lookup)
	Interfaces  []string // interface names from network-status annotation
}

type Discovery struct {
	cs         *kubernetes.Clientset
	namespaces []string
	nodeName   string
}

func NewDiscovery(namespaces []string, nodeName string) (*Discovery, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		home, _ := os.UserHomeDir()
		kc := filepath.Join(home, ".kube", "config")
		if kp := os.Getenv("KUBECONFIG"); kp != "" {
			kc = kp
		}
		cfg, err = clientcmd.BuildConfigFromFlags("", kc)
		if err != nil {
			return nil, err
		}
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Discovery{cs: cs, namespaces: namespaces, nodeName: nodeName}, nil
}

// Run polls for pods every 10 seconds and calls cb with the current list.
func (d *Discovery) Run(ctx context.Context, cb func([]PodInfo)) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	// Initial discovery
	pods := d.listPods(ctx)
	cb(pods)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pods := d.listPods(ctx)
			cb(pods)
		}
	}
}

func (d *Discovery) listPods(ctx context.Context) []PodInfo {
	var result []PodInfo
	for _, ns := range d.namespaces {
		pods, err := d.cs.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
			FieldSelector: "status.phase=Running",
		})
		if err != nil {
			log.Warn().Err(err).Str("ns", ns).Msg("list pods")
			continue
		}
		for _, pod := range pods.Items {
			if pod.Status.Phase != corev1.PodRunning {
				continue
			}
			if d.nodeName != "" && pod.Spec.NodeName != d.nodeName {
				continue
			}
			ifaces := parseInterfaces(pod.Annotations)
			// Prefer the first non-pause container ID for cgroupv2 PID matching
			containerID := ""
			for _, cs := range pod.Status.ContainerStatuses {
				if cs.ContainerID != "" {
					containerID = cs.ContainerID
					break
				}
			}
			result = append(result, PodInfo{
				Name:        pod.Name,
				Namespace:   pod.Namespace,
				NodeName:    pod.Spec.NodeName,
				UID:         string(pod.UID),
				ContainerID: containerID,
				Interfaces:  ifaces,
			})
		}
	}
	return result
}

func parseInterfaces(annotations map[string]string) []string {
	raw, ok := annotations["k8s.v1.cni.cncf.io/network-status"]
	if !ok {
		return []string{"eth0"}
	}

	// Quick parse to get interface names
	ifaces := []string{}
	// Find all "interface": "X" patterns
	i := 0
	for i < len(raw) {
		idx := indexOf(raw, `"interface"`, i)
		if idx == -1 {
			break
		}
		idx += len(`"interface"`)
		// skip whitespace and colon
		for idx < len(raw) && (raw[idx] == ' ' || raw[idx] == ':' || raw[idx] == '\t') {
			idx++
		}
		if idx < len(raw) && raw[idx] == '"' {
			idx++
			end := indexOf(raw, `"`, idx)
			if end > idx {
				ifaces = append(ifaces, raw[idx:end])
				idx = end + 1
			}
		}
		i = idx
	}
	if len(ifaces) == 0 {
		return []string{"eth0"}
	}
	return ifaces
}

func indexOf(s, sub string, from int) int {
	if from >= len(s) {
		return -1
	}
	idx := len(s)
	for i := from; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			idx = i
			break
		}
	}
	if idx == len(s) {
		return -1
	}
	return idx
}
